import { NextRequest, NextResponse } from "next/server";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import chromium from "@sparticuz/chromium";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import puppeteer from "puppeteer-core";
import {
  checkAndReserveConversion,
} from "@/lib/serverRateLimit";
import { latexToHtml, polishLaTeX, RESUME_HTML_STYLES } from "@/lib/latex";

const isVercel = process.env.VERCEL === "1";

export const runtime = "nodejs";
/** Vercel: 60s requires Pro plan; Hobby is limited to 10s (causes FUNCTION_INVOCATION_TIMEOUT). */
export const maxDuration = 60;

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // ~10MB

/** Detect LLM/provider rate limit or quota errors (429, quota exceeded, resource exhausted). */
function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  return (
    code === "429" ||
    /rate limit|rate_limit|ratelimit|quota|resource exhausted|resource_exhausted|too many requests|429/i.test(lower) ||
    /quota exceeded|billing|limit exceeded/i.test(lower)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractTextFromFile(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
    throw new Error("File is too large. Please upload a file under 10MB.");
  }

  const mimeType = file.type;
  const lowerName = file.name.toLowerCase();

  if (mimeType === "application/pdf" || lowerName.endsWith(".pdf")) {
    const parsed = await pdfParse(buffer);
    return parsed.text || "";
  }

  if (
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    lowerName.endsWith(".docx")
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  throw new Error("Unsupported file type. Please upload a PDF or DOCX file.");
}

function extractNameFromLatex(latexCode: string): string {
  // Prefer \name{...} (resume.cls format)
  const nameMatch = latexCode.match(/\\name\{([^}]+)\}/);
  if (nameMatch?.[1]) {
    return nameMatch[1].trim().replace(/\s+/g, " ");
  }
  // Fallback: \textbf{\Large Name} or \textbf{Name} or center block
  const patterns = [
    /\\textbf\{\\Large\s+([^}]+)\}/,
    /\\textbf\{([^}]+)\}.*?\\\\/,
    /\\begin\{center\}[\s\S]*?\\textbf\{([^}]+)\}/,
  ];

  for (const pattern of patterns) {
    const match = latexCode.match(pattern);
    if (match && match[1]) {
      let name = match[1].trim();
      // Clean up LaTeX commands that might be in the name
      name = name.replace(/\\Large\s*/g, '');
      name = name.replace(/\\textbf\{([^}]+)\}/g, '$1');
      name = name.replace(/\\textit\{([^}]+)\}/g, '$1');
      // Take first line if multiple lines
      name = name.split('\\\\')[0].trim();
      // Remove any remaining LaTeX commands
      name = name.replace(/\\[a-zA-Z]+\{?[^}]*\}?/g, '').trim();
      if (name && name.length > 0 && name.length < 100) {
        return name;
      }
    }
  }

  // Fallback: try to extract from original resume text
  return "";
}

function generateFilename(name: string, fallback: string = "Resume"): string {
  if (!name || name.trim().length === 0) {
    return `${fallback}_Tailored_Resume.pdf`;
  }

  // Clean the name: remove special characters, replace spaces with underscores
  let cleanName = name
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special characters except spaces and hyphens
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/_+/g, '_') // Replace multiple underscores with single
    .replace(/^_|_$/g, ''); // Remove leading/trailing underscores

  // Limit length
  if (cleanName.length > 50) {
    cleanName = cleanName.substring(0, 50);
  }

  return `${cleanName}_Tailored_Resume.pdf`;
}

/** Convert LaTeX resume body to PDF using Puppeteer/Chromium (same polished output as before). */
async function latexToPdf(latexCode: string, scale: number = 1): Promise<Buffer> {
  const htmlContent = latexToHtml(latexCode);
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${RESUME_HTML_STYLES}</style>
</head>
<body>
${htmlContent}
</body>
</html>`;

  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  if (isVercel) {
    (chromium as { setGraphicsMode?: boolean }).setGraphicsMode = false;
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: chromium.args,
      executablePath,
      headless: true,
    });
  } else {
    const puppeteerFull = await import("puppeteer");
    browser = (await puppeteerFull.default.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    })) as unknown as Awaited<ReturnType<typeof puppeteer.launch>>;
  }

  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "domcontentloaded" });

  const pdfBuffer = await page.pdf({
    format: "A4",
    scale,
    margin: {
      top: "0.75in",
      right: "0.75in",
      bottom: "0.75in",
      left: "0.75in",
    },
    printBackground: true,
  });

  await browser.close();
  return Buffer.from(pdfBuffer);
}

async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
  try {
    const parsed = await pdfParse(pdfBuffer);
    return typeof parsed.numpages === "number" ? parsed.numpages : 1;
  } catch {
    // If page counting fails, avoid blocking resume generation.
    return 1;
  }
}

async function getTailoredResume({
  resumeText,
  jobDescription,
  shortenHint,
}: {
  resumeText: string;
  jobDescription: string;
  shortenHint?: string;
}): Promise<string> {
  const apiKey =
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";

  if (!apiKey) {
    throw new Error(
      "Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY in your environment.",
    );
  }

  const model = new ChatGoogleGenerativeAI({
    model: "gemini-2.5-flash",
    apiKey,
    temperature: 0.1,
  });

  const prompt = `
You are an expert resume writer. You output a one-page LaTeX resume body that matches the EXACT format below. Use ONLY information from the candidate's resume; never invent job titles, companies, dates, numbers, or skills. Contact info (name, email, phone, location, links) must come exactly from the resume.

EXACT LaTeX BODY FORMAT (resume.cls style — copy this structure):

Header (first lines):
\\name{Candidate Full Name}
\\address{Phone \\\\ City, Country}
\\address{\\href{mailto:email}{email} \\\\ 
\\href{portfolio-url}{Portfolio} \\\\
\\href{linkedin-url}{LinkedIn} \\\\
\\href{github-url}{GitHub}} %

Sections use \\begin{rSection}{Title} ... \\end{rSection}. After \\begin{rSection} put \\footnotesize on the next line. Section order: Experience, Projects, Skills, Education, Certifications and Publications.
Keep style close to a FAANG simple template: compact spacing, strong section headings, concise one-line bullets.

Experience (exact pattern per role):
\\normalsize \\begin{rSection}{Experience}
\\footnotesize

\\textbf{Company Name} 
\\hfill \\textit{City, State or Country}\\\\
Role Title \\hfill Month YYYY - Month YYYY
 \\begin{itemize}
    \\itemsep -2pt {} 
    \\item Achievement (max 12 words).
 \\end{itemize}
\\end{rSection}

Projects (exact pattern):
\\normalsize \\begin{rSection}{Projects}
\\vspace{-1.15em}
\\footnotesize

\\item \\textbf{Project Name} \\href{url}{Link}
 \\begin{itemize}
    \\itemsep -2pt {} 
    \\item Outcome (max 12 words).
 \\end{itemize}
\\end{rSection}

Skills (exact tabular; use \\& for ampersand in text):
\\normalsize \\begin{rSection}{Skills}
\\footnotesize
\\begin{tabular}{ @{} >{\\bfseries}l @{\\hspace{6ex}} l }
Languages & Java, Python\\\\
Frontend & React, Next.js\\\\
Backend & REST API\\\\
\\end{tabular}
\\end{rSection}

Education:
\\normalsize \\begin{rSection}{Education}
\\footnotesize
{\\bf Institution Name}, Degree \\hfill {Month YYYY - Month YYYY}\\\\
CGPA or grade
\\end{rSection}

Certifications and Publications:
\\normalsize \\begin{rSection}{Certifications and Publications} 
\\footnotesize
\\begin{itemize} 
    \\item Name \\href{url}{Link}
\\end{itemize}
\\end{rSection}

CRITICAL: Output ONLY raw LaTeX. No \\documentclass, \\usepackage, \\begin{document}, \\end{document}. No markdown, no code fences, no commentary.
Use \\name{Name} and \\address{...} for header. Use \\begin{rSection}{Title} and \\end{rSection} for every section. Do NOT use \\section{}.
Every \\begin{itemize} must include on next line: \\itemsep -2pt {} then newline then \\item ...
In tabular use \\& for ampersand in text. Use \\\\ for row ends. Escape \\& \\% \\# \\$ in body text.
One A4 page: max 3 experience roles (2 bullets each by default), max 3 projects, max 2 bullets per project.
Each bullet must be one line and 8-12 words only. Prefer fewer bullets over overflow.
Section order: Experience, Projects, Skills, Education, Certifications and Publications.
IMPORTANT: Do NOT include a section heading if there is no real content for it.
If Certifications/Publications is empty, omit the entire rSection.
${shortenHint ? `\nSHORTEN: Cut bullets and wording further; keep same structure.\n\n` : ""}

Candidate resume:
-----------------
${resumeText}

Job description:
----------------
${jobDescription}

Output ONLY the LaTeX resume body (no preamble, no markdown):
`;

  const MAX_LLM_RETRIES = 2;
  const BACKOFF_MS = [1000]; // 1s on rate limit (keep time low for Hobby)

  let response: Awaited<ReturnType<typeof model.invoke>> | undefined;
  for (let attempt = 0; attempt < MAX_LLM_RETRIES; attempt++) {
    try {
      response = await model.invoke(prompt);
      break;
    } catch (invokeError) {
      const isLastAttempt = attempt === MAX_LLM_RETRIES - 1;
      if (isRateLimitError(invokeError) && !isLastAttempt) {
        const delay = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
        console.warn(`LLM rate limit (attempt ${attempt + 1}/${MAX_LLM_RETRIES}), retrying in ${delay}ms...`, invokeError);
        await sleep(delay);
      } else {
        throw invokeError;
      }
    }
  }
  if (!response) {
    throw new Error("LLM did not return a response.");
  }
  const content = response.content;

  if (typeof content === "string") {
    return content.trim();
  }

  // content may be a structured array
  if (Array.isArray(content)) {
    const combined = content
      .map((chunk) => {
        if (typeof chunk === "string") return chunk;
        if (chunk && typeof chunk === "object") {
          // Handle different content types
          const chunkObj = chunk as Record<string, unknown>;
          const maybeText = chunkObj["text"];
          if (typeof maybeText === "string") return maybeText;
        }
        return "";
      })
      .join("\n")
      .trim();
    return combined;
  }

  return String(content).trim();
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const userId = String(formData.get("userId") || "").trim();
    const file = formData.get("resume");
    const resumeTextInput = String(formData.get("resumeText") || "").trim();
    const jobDescription = String(formData.get("jobDescription") || "").trim();

    // Verify user authentication
    if (!userId) {
      return NextResponse.json(
        { error: "User authentication required." },
        { status: 401 },
      );
    }

    // Server-side rate limiting check and reservation (atomic operation prevents race conditions)
    // This reserves a conversion slot immediately, preventing multiple simultaneous requests
    const limitCheck = await checkAndReserveConversion(userId);
    if (!limitCheck.allowed) {
      return NextResponse.json(
        { error: limitCheck.reason || "Conversion limit reached." },
        { status: 429 }, // 429 Too Many Requests
      );
    }
    // Note: Conversion is already recorded atomically in checkAndReserveConversion
    // If processing fails, we should rollback (but for simplicity, we'll keep it reserved)

    if (!jobDescription) {
      return NextResponse.json(
        { error: "Job description is required." },
        { status: 400 },
      );
    }

    let resumeText: string;

    if (resumeTextInput) {
      // Use pasted text if provided
      resumeText = resumeTextInput;
    } else if (file && file instanceof File) {
      // Extract text from uploaded file
      resumeText = (await extractTextFromFile(file)).trim();
    } else {
      return NextResponse.json(
        { error: "Please provide either a resume file or paste resume text." },
        { status: 400 },
      );
    }

    if (!resumeText) {
      return NextResponse.json(
        {
          error:
            "Resume text is empty. Please provide a valid resume file or paste resume content.",
        },
        { status: 400 },
      );
    }

    // Generate resume body, render PDF, and enforce single-page output with one retry.
    let latexCode = polishLaTeX(
      await getTailoredResume({
        resumeText,
        jobDescription,
      }),
    );
    let pdfBuffer = await latexToPdf(latexCode);
    let pageCount = await getPdfPageCount(pdfBuffer);

    if (pageCount > 1) {
      const shortenHint =
        `The previous output rendered to ${pageCount} pages. ` +
        "Shorten aggressively: keep only highest-impact bullets, reduce each bullet to 8-12 words, " +
        "use at most 2 bullets per role/project, and keep skills concise so final PDF is exactly 1 page.";
      latexCode = polishLaTeX(
        await getTailoredResume({
          resumeText,
          jobDescription,
          shortenHint,
        }),
      );
      pdfBuffer = await latexToPdf(latexCode);
      pageCount = await getPdfPageCount(pdfBuffer);
    }

    // Final rendering safeguard: gently scale down if content still overflows.
    if (pageCount > 1) {
      pdfBuffer = await latexToPdf(latexCode, 0.92);
    }

    const extractedName = extractNameFromLatex(latexCode);
    const filename = generateFilename(extractedName);

    return NextResponse.json({
      tailoredResumePdf: pdfBuffer.toString("base64"),
      tailoredResumeText: latexCode,
      filename,
    });
  } catch (error) {
    console.error("Error tailoring resume:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error occurred.";
    const isCredentialsError =
      /default credentials|credentials|FIREBASE_SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS/i.test(
        message
      );
    const isRateLimited = isRateLimitError(error);
    const userMessage = isRateLimited
      ? "The resume service is temporarily busy due to high demand. Please try again in a few minutes."
      : isCredentialsError
        ? "Server configuration: set FIREBASE_SERVICE_ACCOUNT (Firebase service account JSON) for tailoring and rate limiting to work. See Firebase Admin setup docs."
        : process.env.NODE_ENV === "development"
          ? message
          : "Please try again later.";
    const status = isRateLimited ? 503 : 500;

    return NextResponse.json(
      { error: isRateLimited ? userMessage : "Failed to tailor resume. " + userMessage },
      { status },
    );
  }
}


