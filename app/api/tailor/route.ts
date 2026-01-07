import { NextRequest, NextResponse } from "next/server";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

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
    model: "gemini-1.5-flash",
    apiKey,
    temperature: 0.4,
  });

  const prompt = `
You are an expert resume writer.

Task:
- Take the candidate resume and the job description.
- Rewrite the resume so it is clearly targeted to the job, while remaining honest and realistic.
- Keep the structure readable with clear section headings and bullet points.
- Keep the language concise and professional.

Important formatting rules:
- Return ONLY the full tailored resume text.
- Do not include explanations, commentary, or markdown.
- Preserve line breaks between sections and bullet points so it can be copied into a document editor.

Candidate resume:
-----------------
${resumeText}

Job description:
----------------
${jobDescription}

Tailored resume:
----------------
`;

  const response = await model.invoke(prompt);

  const content = response.content;

  if (typeof content === "string") {
    return content.trim();
  }

  // content may be a structured array
  // @ts-ignore - content can be an array with "text" fields
  const combined = content
    // @ts-ignore
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (typeof chunk?.text === "string") return chunk.text;
      return "";
    })
    .join("\n")
    .trim();

  return combined;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("resume");
    const jobDescription = String(formData.get("jobDescription") || "").trim();

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Missing resume file in request." },
        { status: 400 },
      );
    }

    if (!jobDescription) {
      return NextResponse.json(
        { error: "Job description is required." },
        { status: 400 },
      );
    }

    const resumeText = (await extractTextFromFile(file)).trim();

    if (!resumeText) {
      return NextResponse.json(
        {
          error:
            "Could not read any text from the uploaded file. Please upload a text-based PDF or DOCX file.",
        },
        { status: 400 },
      );
    }

    const tailoredResumeText = await getTailoredResume({
      resumeText,
      jobDescription,
    });

    return NextResponse.json({ tailoredResumeText });
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


