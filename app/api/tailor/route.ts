import { NextRequest, NextResponse } from "next/server";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import puppeteer from "puppeteer";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // ~10MB

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
  </style>
</head>
<body>
${htmlContent}
</body>
</html>`;

    // Use puppeteer to convert HTML to PDF
    const browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    
    // Set content with proper styling
    await page.setContent(html, { waitUntil: "networkidle0" });
    
    // Generate PDF
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
}: {
  resumeText: string;
  jobDescription: string;
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
    temperature: 0.4,
  });

  const prompt = `
You are an expert resume writer specializing in creating ATS-friendly (Applicant Tracking System) resumes that are clean, professional, and optimized for both human recruiters and automated systems.

Your task:
1. Analyze the candidate's resume and the job description
2. Rewrite the resume to be clearly targeted to the job while remaining honest and realistic
3. Ensure the resume is ATS-friendly and follows professional resume best practices
4. Create a clean, well-structured, and professional document in LaTeX format

CRITICAL: You MUST return ONLY valid LaTeX code for the resume content (without \\documentclass, \\begin{document}, or \\end{document} - those will be added automatically). The LaTeX code should contain only the resume body content.

LaTeX Formatting Requirements:
- Use \\section{Section Name} for main sections: "Contact Information", "Professional Summary" or "Summary", "Work Experience" or "Professional Experience", "Education", "Skills", "Certifications"
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
- Include relevant keywords from the job description naturally throughout the resume
- Use standard date formats
- Include quantifiable achievements where possible (numbers, percentages, dollar amounts)
- Keep formatting simple and ATS-parseable

Professional Standards:
- Keep language concise, clear, and action-oriented
- Use strong action verbs (e.g., "Developed", "Managed", "Implemented", "Led", "Optimized")
- Focus on achievements and impact rather than just responsibilities
- Ensure consistency in tense (past tense for previous roles, present tense for current role)
- Maintain professional tone throughout

Structure Guidelines:
- Start with candidate name (centered, large, bold): \\begin{center}\\textbf{\\Large Name}\\\\Contact Info\\end{center}
- Follow with Professional Summary section
- List Work Experience in reverse chronological order (most recent first)
- Include Education section
- Include Skills section (both technical and soft skills relevant to the job)
- Add any relevant Certifications, Awards, or Additional sections if applicable

Example LaTeX structure:
\\begin{center}
\\textbf{\\Large John Doe}\\\\
john.doe@email.com | (555) 123-4567 | linkedin.com/in/johndoe | City, State
\\end{center}

\\section{Professional Summary}
Brief summary here...

\\section{Work Experience}
\\textbf{Job Title} \\hfill \\textit{Date Range}\\\\
\\textbf{Company Name} \\hfill \\textit{Location}
\\begin{itemize}
\\item Achievement or responsibility
\\item Another achievement
\\end{itemize}

\\section{Education}
\\textbf{Degree Name} \\hfill \\textit{Date}\\\\
\\textbf{University Name} \\hfill \\textit{Location}

\\section{Skills}
Skill 1, Skill 2, Skill 3, Skill 4

IMPORTANT: Return ONLY the LaTeX code for the resume body content. Do NOT include:
- \\documentclass
- \\usepackage commands
- \\begin{document} or \\end{document}
- Any explanations or commentary
- Markdown formatting

Candidate resume:
-----------------
${resumeText}

Job description:
----------------
${jobDescription}

LaTeX code for tailored resume (ATS-friendly, clean, and professional):
------------------------------------------------------------------------
`;

  const response = await model.invoke(prompt);

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
          const chunkAny = chunk as any;
          if (typeof chunkAny.text === "string") {
            return chunkAny.text;
          }
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
    const file = formData.get("resume");
    const resumeTextInput = String(formData.get("resumeText") || "").trim();
    const jobDescription = String(formData.get("jobDescription") || "").trim();

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

    const latexCode = await getTailoredResume({
      resumeText,
      jobDescription,
    });

    // Convert LaTeX to PDF
    const pdfBuffer = await latexToPdf(latexCode);

    // Return PDF as base64 encoded string
    const pdfBase64 = pdfBuffer.toString("base64");

    return NextResponse.json({
      tailoredResumePdf: pdfBase64,
      tailoredResumeText: latexCode, // Also return LaTeX for reference
    });
  } catch (error) {
    console.error("Error tailoring resume:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error occurred.";

    return NextResponse.json(
      {
        error:
          "Failed to tailor resume. " +
          (process.env.NODE_ENV === "development"
            ? message
            : "Please try again later."),
      },
      { status: 500 },
    );
  }
}


