import { NextRequest, NextResponse } from "next/server";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import chromium from "@sparticuz/chromium";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import puppeteer from "puppeteer-core";
import {
  checkAndReserveConversion,
} from "@/lib/serverRateLimit";

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

/** Returns the number of pages in a PDF buffer. */
async function getPdfPageCount(pdfBuffer: Buffer): Promise<number> {
  const parsed = await pdfParse(pdfBuffer);
  return (parsed as { numpages?: number }).numpages ?? 0;
}

function latexToHtml(latexCode: string): string {
  // Convert LaTeX commands to HTML
  let html = latexCode;

  // Handle nested structures first - process from innermost to outermost
  // Replace href before other replacements
  html = html.replace(/\\href\{([^}]+)\}\{([^}]+)\}/g, '<a href="$1">$2</a>');
  
  // Replace text formatting (can be nested)
  let changed = true;
  while (changed) {
    const before = html;
    html = html.replace(/\\textbf\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '<strong>$1</strong>');
    html = html.replace(/\\textit\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '<em>$1</em>');
    changed = html !== before;
  }
  
  // Replace center environment
  html = html.replace(/\\begin\{center\}([\s\S]*?)\\end\{center\}/g, (match, content) => {
    return `<div class="center">${content.trim()}</div>`;
  });
  
  // Replace itemize environment
  html = html.replace(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g, (match, content) => {
    const items = content.split(/\\item\s+/).filter((item: string) => item.trim());
    const listItems = items.map((item: string) => `<li>${item.trim()}</li>`).join('');
    return `<ul class="resume-list">${listItems}</ul>`;
  });
  
  // Replace section
  html = html.replace(/\\section\{([^}]+)\}/g, '<h2 class="section-title">$1</h2>');

  // Replace tabular (e.g. skills table: Category & skills \\)
  html = html.replace(/\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/g, (_, content) => {
    const rows = content.split(/\\\\/).map((r: string) => r.trim()).filter(Boolean);
    const trs = rows.map((row: string) => {
      const cells = row.split(/&/).map((c: string) => c.trim());
      const tds = cells.map((cell: string) => `<td>${cell}</td>`).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table class="resume-table">${trs}</table>`;
  });

  // Replace other commands
  html = html.replace(/\\Large\s*/g, '');
  html = html.replace(/\\\\/g, '<br>');
  html = html.replace(/\\vspace\{([^}]+)\}/g, '<div style="height: $1"></div>');
  html = html.replace(/\\hfill/g, '<span style="float: right;"></span>');
  
  // Replace escaped characters
  html = html.replace(/\\&/g, '&');
  html = html.replace(/\\%/g, '%');
  html = html.replace(/\\#/g, '#');
  html = html.replace(/\\\$/g, '$');
  html = html.replace(/\\\{/g, '{');
  html = html.replace(/\\\}/g, '}');
  
  // Clean up extra whitespace
  html = html.replace(/\n{3,}/g, '\n\n');
  
  // Wrap paragraphs
  const lines = html.split('\n');
  const wrappedLines: string[] = [];
  let currentParagraph = '';
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentParagraph) {
        wrappedLines.push(`<p>${currentParagraph}</p>`);
        currentParagraph = '';
      }
      wrappedLines.push('');
    } else if (trimmed.startsWith('<')) {
      // Already HTML tag
      if (currentParagraph) {
        wrappedLines.push(`<p>${currentParagraph}</p>`);
        currentParagraph = '';
      }
      wrappedLines.push(trimmed);
    } else {
      currentParagraph += (currentParagraph ? ' ' : '') + trimmed;
    }
  }
  
  if (currentParagraph) {
    wrappedLines.push(`<p>${currentParagraph}</p>`);
  }
  
  return wrappedLines.join('\n');
}

function extractNameFromLatex(latexCode: string): string {
  // Try to extract name from LaTeX code
  // Look for patterns like \textbf{\Large Name} or \textbf{Name}
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

async function latexToPdf(latexCode: string): Promise<Buffer> {
  try {
    // Convert LaTeX to HTML
    const htmlContent = latexToHtml(latexCode);

    // Create a complete HTML document with professional styling
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page {
      margin: 0.75in;
      size: A4;
    }
    body {
      font-family: 'Times New Roman', Times, serif;
      font-size: 11pt;
      line-height: 1.4;
      color: #000;
      max-width: 8.5in;
      margin: 0 auto;
      padding: 0;
    }
    .center {
      text-align: center;
      margin-bottom: 12pt;
    }
    .center strong {
      font-size: 18pt;
      font-weight: bold;
    }
    .section-title {
      font-size: 14pt;
      font-weight: bold;
      color: #000000;
      margin-top: 12pt;
      margin-bottom: 6pt;
      border-bottom: 1px solid #000000;
      padding-bottom: 2pt;
    }
    .resume-list {
      margin: 4pt 0;
      padding-left: 20pt;
      list-style-type: disc;
    }
    .resume-list li {
      margin: 2pt 0;
      padding-left: 4pt;
    }
    p {
      margin: 4pt 0;
    }
    strong {
      font-weight: bold;
    }
    em {
      font-style: italic;
    }
    a {
      color: #000000;
      text-decoration: none;
    }
    [style*="float: right"] {
      float: right;
    }
    .resume-table {
      width: 100%;
      border-collapse: collapse;
      margin: 4pt 0;
      font-size: inherit;
    }
    .resume-table td {
      padding: 2pt 8pt 2pt 0;
      vertical-align: top;
    }
    .resume-table tr td:first-child {
      font-weight: bold;
      white-space: nowrap;
      width: 1%;
    }
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;

    let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
    if (isVercel) {
      (chromium as { setGraphicsMode?: boolean }).setGraphicsMode = false;
      // Use package default bin path (relative to @sparticuz/chromium), not process.cwd(),
      // so brotli files are found in serverless bundle where the package is actually resolved.
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
  } catch (error) {
    console.error("Error converting LaTeX to PDF:", error);
    throw new Error("Failed to convert LaTeX to PDF. Please ensure LaTeX code is valid.");
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
    temperature: 0.3,
  });

  const prompt = `
You are an expert resume writer creating ATS-friendly, one-page resumes. You THINK before you write: you select only content that is (1) present in the candidate's resume, (2) relevant to the job, and (3) impactful. You never invent or embellish.

NO HALLUCINATION — STRICT RULES:
- Use ONLY information that appears in the candidate's resume. Do not invent, assume, or add any facts.
- Do NOT make up: job titles, company names, dates, numbers, metrics, percentages, dollar amounts, technologies, or achievements. If the resume does not state a number or metric, do not add one.
- You MAY: paraphrase for clarity and concision, reorder bullet points by relevance, choose which roles/achievements to include to fit one page, and use stronger action verbs when the original meaning is preserved.
- You MAY NOT: add responsibilities or achievements not stated in the resume, inflate numbers, invent tools or projects, or imply experience the candidate did not claim.
- Contact info (name, email, phone, location, links) must come exactly from the resume. Do not guess or fill in missing contact details with placeholders.

SELECTION AND REASONING:
- First, identify which roles, achievements, skills, and education from the candidate's resume are most relevant to the job description.
- Include only content that is both clearly present in the source resume AND relevant/impactful for this job. Omit anything that does not directly support the candidate's fit.
- For each bullet: base it on a specific achievement or responsibility from the resume. Tighten and sharpen the wording; do not add new claims.
- Skills: list only skills that appear in the candidate's resume. Order or emphasize those that match the job; do not add skills the candidate did not list.
- If the resume is sparse, output less content—never pad with invented details.

Your task:
1. Analyze the candidate's resume and the job description.
2. Select only the most relevant, impactful content that is explicitly in the resume.
3. Rewrite that content into a clean, targeted, one-page LaTeX resume. No new facts.
4. Ensure the document is ATS-friendly and professional.

RESUME STRUCTURE AND STYLE REFERENCE (follow this layout and formatting):
- Header: Candidate name (centered, large, bold). Then contact block: phone and location on one line; then email, portfolio, LinkedIn, GitHub each on its own line using \\href{url}{text} for links.
- Section order: (1) Education, (2) Projects (if the candidate has projects and space permits), (3) Experience, (4) Skills, (5) Certifications/Publications (if relevant).
- Education: Institution name in \\textbf{}. Degree and date on same line (date right with \\hfill \\textit{Date}). Grades or details on next line. Use reverse chronological order.
- Projects (optional): For each project use \\textbf{Project Name} and optional \\href{}{Link}. Then \\begin{itemize} with \\item for 2-3 bullets. Use concise, outcome-focused bullets (e.g., "Built...", "Designed...", "Developed...").
- Experience: For each role: \\textbf{Company Name} \\hfill \\textit{Location}\\\\ then Role title \\hfill Date range\\\\ then \\begin{itemize} with \\item for 3-5 achievement bullets. Put company and location on first line, role and date on second. Use strong action verbs and quantifiable results when present in the resume.
- Skills: Use a two-column table so categories are clear. Format: \\begin{tabular}{ @{} >{\\bfseries}l @{\\hspace{6ex}} l } Category & Skills\\\\ ... \\end{tabular}. Use categories that fit the candidate (e.g., Languages, Frontend, Backend/Cloud, Database, Developer Tools, Other, Concepts, Soft Skills). Only include skills from the resume; order by relevance to the job.
- Certifications/Publications: Simple \\begin{itemize} \\item ... with \\href for links when available.
- Use \\\\ for line breaks and \\hfill for right-aligned dates/locations. Keep bullet lists tight and scannable.

CRITICAL REQUIREMENTS:
- Return ONLY valid LaTeX code for the resume body (no \\documentclass, \\usepackage, \\begin{document}, or \\end{document}). LaTeX code only.
- The resume MUST fit on one A4 page with 0.75in margins. Be selective and concise.
- DO NOT include a Professional Summary section. Use section order: Education, then Projects (if any), then Experience, then Skills, then Certifications.
- For each position, include 3-5 bullet points that are grounded in the candidate's resume and most relevant to the job (include more content initially, only reduce if space requires).
- Prioritize achievements that: (1) are stated in the resume, (2) align with job requirements, (3) are quantifiable when the candidate provided numbers, (4) demonstrate impact.
- Skills: Use a tabular format with category in first column (bold) and skills in second: \\begin{tabular}{ @{} >{\\bfseries}l @{\\hspace{6ex}} l } Languages & ...\\\\ Frontend & ...\\\\ Backend/Cloud & ...\\\\ ... \\end{tabular}. Use categories that fit the candidate (Languages, Frontend, Backend/Cloud, Developer Tools, Other, Concepts, Soft Skills). Only skills from the resume. Education: degree, institution, date from the resume only.

LaTeX Formatting Requirements:
- Use \\section{Section Name} for main sections: "Contact Information", "Work Experience" or "Professional Experience", "Education", "Skills", "Certifications"
- Use \\textbf{text} for bold text (e.g., job titles, company names, degree names)
- Use \\textit{text} for italic text (e.g., dates, locations)
- Use \\begin{itemize} and \\end{itemize} with \\item for bullet points
- Use \\textbf{Name} at the top for the candidate's name (centered, large)
- Use proper LaTeX escaping: \\& for &, \\% for %, \\# for #, \\$ for $
- Use \\\\ for line breaks within sections
- Use \\vspace{2pt} for small vertical spacing when needed
- Format dates consistently: \\textit{Month YYYY - Present} or \\textit{Month YYYY - Month YYYY}
- Use \\href{url}{text} for links (email, LinkedIn, websites)

ATS-Friendly Requirements:
- Use standard section headings that ATS systems can parse
- Phrase the candidate's experience so job-relevant terms from the job description appear where they honestly apply to what the candidate did (do not add experience to match keywords)
- Use standard date formats; use only dates from the resume
- Keep quantifiable achievements as stated in the resume; do not add or estimate numbers
- Keep formatting simple and ATS-parseable

Professional Standards:
- Use concise, clear, action-oriented language. Base every phrase on the candidate's resume.
- Prefer strong action verbs (e.g., "Developed", "Managed", "Implemented") when they accurately reflect the candidate's wording
- Focus on achievements and impact that the candidate actually stated
- Use past tense for previous roles, present tense for current role
- Maintain a professional tone; never exaggerate or invent

Structure Guidelines:
- Start with candidate name (centered, large, bold), then contact block: phone and location; then email, portfolio, LinkedIn, GitHub on separate lines with \\href for links.
- Section order: Education first, then Projects (if candidate has projects), then Experience, then Skills, then Certifications.
- Education: \\textbf{Institution}, degree and date (date right). Include grades if in resume. Reverse chronological order.
- Projects (optional): \\textbf{Project Name} optional \\href{}{Link}, then bullet list with outcome-focused items.
- Experience: \\textbf{Company} \\hfill \\textit{Location}\\\\ Role \\hfill Date\\\\ then 3-5 bullet achievements. Reverse chronological order. Preserve important details.
- Skills: Use tabular with bold category column and skills column (see RESUME STRUCTURE REFERENCE). Categories: Languages, Frontend, Backend/Cloud, Developer Tools, Other, Concepts, Soft Skills as applicable.
- Certifications/Publications: List with \\href for links when available.

Single-Page Constraint:
- The entire resume must fit on one A4 page with 0.75in margins
- IMPORTANT: Include comprehensive content initially. Only shorten if the PDF exceeds one page after generation.
- When cutting for space: keep only content that is in the resume and relevant to the job. Drop less relevant items; never add new ones
- Quality over quantity: include substantial, accurate content rather than being overly brief
- Use concise language but preserve important details and achievements

Example LaTeX structure (match this style):
\\begin{center}
\\textbf{\\Large Name}\\\\
Phone | City, State\\\\
\\href{mailto:email}{email}\\\\
\\href{url}{Portfolio}\\\\
\\href{url}{LinkedIn}\\\\
\\href{url}{GitHub}
\\end{center}

\\section{Education}
\\textbf{Institution Name}, Degree \\hfill \\textit{Date}\\\\
Grade or detail line

\\section{Projects}
\\textbf{Project Name} \\href{url}{Link}
\\begin{itemize}
\\item Outcome-focused bullet
\\end{itemize}

\\section{Experience}
\\textbf{Company Name} \\hfill \\textit{Location}\\\\
Role Title \\hfill Date Range
\\begin{itemize}
\\item Achievement bullet
\\end{itemize}

\\section{Skills}
\\begin{tabular}{ @{} >{\\bfseries}l @{\\hspace{6ex}} l }
Languages & JavaScript, TypeScript, Python\\\\
Frontend & React, Next.js, Figma\\\\
Backend/Cloud & AWS, Supabase, REST API\\\\
Developer Tools & Git, Docker, CI/CD
\\end{tabular}

\\section{Certifications and Publications}
\\begin{itemize}
\\item Certification name \\href{url}{Link}
\\end{itemize}

IMPORTANT: Return ONLY the LaTeX code for the resume body content. Do NOT include:
- \\documentclass, \\usepackage, \\begin{document}, or \\end{document}
- Any explanations, commentary, or markdown
- Any information not taken from the candidate's resume (no hallucination)
${shortenHint ? `\nCRITICAL — SHORTEN (previous attempt was more than one page):\n${shortenHint}\n\nIMPORTANT: Even when shortening, maintain the skills categorization structure (Backend, Frontend, etc.) and preserve the most impactful achievements.\n\n` : ""}

Candidate resume:
-----------------
${resumeText}

Job description:
----------------
${jobDescription}

LaTeX code for tailored resume (ATS-friendly, clean, and professional):
------------------------------------------------------------------------
`;

  const MAX_LLM_RETRIES = 3;
  const BACKOFF_MS = [2000, 4000]; // 2s, then 4s

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

    const MAX_PAGE_ITERATIONS = 3;
    let latexCode = "";
    let pdfBuffer: Buffer = Buffer.alloc(0);
    let shortenHint: string | undefined;

    // First iteration: generate comprehensive resume without shortening
    latexCode = await getTailoredResume({
      resumeText,
      jobDescription,
      shortenHint: undefined, // No shortening hint on first attempt
    });
    pdfBuffer = await latexToPdf(latexCode);
    let pageCount = await getPdfPageCount(pdfBuffer);

    // Only iterate if PDF exceeds 1 page
    if (pageCount > 1) {
      for (let iteration = 1; iteration < MAX_PAGE_ITERATIONS; iteration++) {
        shortenHint =
          iteration === 1
            ? "Your previous output was more than one page. You MUST shorten it: reduce to 2-3 bullet points per role, use more concise phrasing, omit less relevant roles or sections. The resume MUST fit on a single A4 page. Preserve the most important achievements and maintain skills categorization."
            : "Your output is STILL more than one page. Be more aggressive: at most 2 bullets per role, more concise wording, but still maintain skills categorization. Fit on ONE page only.";
        
        latexCode = await getTailoredResume({
          resumeText,
          jobDescription,
          shortenHint,
        });
        pdfBuffer = await latexToPdf(latexCode);
        pageCount = await getPdfPageCount(pdfBuffer);
        if (pageCount <= 1) break;
      }
    }

    // Extract name from LaTeX code to generate filename
    const extractedName = extractNameFromLatex(latexCode);
    const filename = generateFilename(extractedName);

    // Note: Conversion was already recorded atomically in checkAndReserveConversion
    // to prevent race conditions. No need to record again here.

    // Return PDF as base64 encoded string
    const pdfBase64 = pdfBuffer.toString("base64");

    return NextResponse.json({
      tailoredResumePdf: pdfBase64,
      tailoredResumeText: latexCode, // Also return LaTeX for reference
      filename: filename, // Return suggested filename
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


