"use client";

import { useEffect, useState } from "react";

type UploadedResume = {
  file: File;
  url: string;
};

export default function Home() {
  const [uploadedResume, setUploadedResume] = useState<UploadedResume | null>(
    null,
  );
  const [pastedResumeText, setPastedResumeText] = useState("");
  const [usePastedText, setUsePastedText] = useState(false);
  const [jobDescription, setJobDescription] = useState("");
  const [isTailoring, setIsTailoring] = useState(false);
  const [tailoredResumeText, setTailoredResumeText] = useState<string | null>(
    null,
  );
  const [tailoredDownloadUrl, setTailoredDownloadUrl] = useState<string | null>(
    null,
  );
  const [tailoredFilename, setTailoredFilename] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (uploadedResume?.url) {
        URL.revokeObjectURL(uploadedResume.url);
      }
      if (tailoredDownloadUrl) {
        URL.revokeObjectURL(tailoredDownloadUrl);
      }
    };
  }, [uploadedResume, tailoredDownloadUrl]);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
    ];

    if (!allowedTypes.includes(file.type)) {
      alert("Please upload a PDF or DOCX resume.");
      event.target.value = "";
      return;
    }

    if (uploadedResume?.url) {
      URL.revokeObjectURL(uploadedResume.url);
    }

    const url = URL.createObjectURL(file);
    setUploadedResume({ file, url });
    setTailoredResumeText(null);
    if (tailoredDownloadUrl) {
      URL.revokeObjectURL(tailoredDownloadUrl);
      setTailoredDownloadUrl(null);
    }
  };

  const handleTailorClick = async () => {
    if ((!uploadedResume && !pastedResumeText.trim()) || !jobDescription.trim()) {
      return;
    }

    setIsTailoring(true);
    setError(null);
    setTailoredResumeText(null);
    setTailoredFilename(null);
    if (tailoredDownloadUrl) {
      URL.revokeObjectURL(tailoredDownloadUrl);
      setTailoredDownloadUrl(null);
    }

    try {
      const formData = new FormData();
      if (uploadedResume && !usePastedText) {
        formData.append("resume", uploadedResume.file);
      } else if (pastedResumeText.trim()) {
        formData.append("resumeText", pastedResumeText.trim());
      }
      formData.append("jobDescription", jobDescription);

      const response = await fetch("/api/tailor", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to tailor resume.");
      }

      // Handle PDF download
      if (data.tailoredResumePdf) {
        // Convert base64 to blob
        const pdfBase64 = data.tailoredResumePdf;
        const byteCharacters = atob(pdfBase64);
        const byteNumbers = new Array(byteCharacters.length);
        for (let i = 0; i < byteCharacters.length; i++) {
          byteNumbers[i] = byteCharacters.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        const blob = new Blob([byteArray], { type: "application/pdf" });
        const url = URL.createObjectURL(blob);
        setTailoredDownloadUrl(url);
      }

      // Store filename if provided
      if (data.filename) {
        setTailoredFilename(data.filename);
      } else {
        // Fallback filename
        setTailoredFilename(
          uploadedResume
            ? uploadedResume.file.name.replace(/\.[^.]+$/, "-qfix-tailored.pdf")
            : "qfix-tailored-resume.pdf"
        );
      }

      // Also store LaTeX text for display
      const latexText = String(data.tailoredResumeText || "").trim();
      if (latexText) {
        setTailoredResumeText(latexText);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong.";
      setError(message);
    } finally {
      setIsTailoring(false);
    }
  };

  const isPdf =
    uploadedResume && uploadedResume.file.type === "application/pdf";

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-950 to-slate-900 text-slate-50">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-10 px-6 py-10 md:px-10 lg:flex-row lg:items-stretch lg:gap-16 lg:py-16">
        {/* Left: Hero / Intro */}
        <section className="flex flex-1 flex-col justify-between gap-10">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-700/80 bg-slate-900/60 px-3 py-1 text-xs font-medium text-slate-300 shadow-sm">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Qfix Resume · Smart resume tailoring for every job
            </div>
            <div className="space-y-4">
              <h1 className="text-balance text-4xl font-semibold tracking-tight text-slate-50 sm:text-5xl lg:text-6xl">
                Tailor your resume
                <span className="block bg-gradient-to-r from-emerald-300 via-cyan-300 to-sky-400 bg-clip-text text-transparent">
                  to every job description.
                </span>
              </h1>
              <p className="max-w-xl text-pretty text-base leading-relaxed text-slate-300 sm:text-lg">
                Qfix Resume helps you instantly adapt your resume to match any
                role. Upload your resume, paste the job description, and get a
                targeted version ready to send.
              </p>
            </div>
          </div>

          <div className="space-y-2 text-sm text-slate-400">
            <p>
              Upload your resume, paste the job description, and let Qfix
              Resume suggest a tailored version you can copy or download.
            </p>
          </div>
        </section>

        {/* Right: Upload & Job Description */}
        <section className="flex flex-1 flex-col gap-6 rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-xl shadow-slate-950/60 backdrop-blur-lg md:p-7">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold text-slate-50">
              Get your resume ready in three steps
            </h2>
            <p className="text-sm text-slate-400">
              1. Upload your resume or paste its content · 2. Paste the job
              description · 3. Get your ATS-friendly tailored resume.
            </p>
          </div>

          {/* Resume Input - File Upload or Paste */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-200">
                Your resume
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setUsePastedText(false);
                    setPastedResumeText("");
                  }}
                  className={`text-xs px-2 py-1 rounded transition ${
                    !usePastedText
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/50"
                      : "text-slate-400 hover:text-slate-300"
                  }`}
                >
                  Upload file
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUsePastedText(true);
                    setUploadedResume(null);
                  }}
                  className={`text-xs px-2 py-1 rounded transition ${
                    usePastedText
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/50"
                      : "text-slate-400 hover:text-slate-300"
                  }`}
                >
                  Paste text
                </button>
              </div>
            </div>

            {!usePastedText ? (
              <div className="flex flex-col gap-3 rounded-xl border border-dashed border-slate-700/90 bg-slate-900/60 p-4 text-sm text-slate-300">
                <div className="flex flex-wrap items-center gap-3">
                  <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 shadow-md shadow-emerald-500/40 transition hover:bg-emerald-400 hover:shadow-emerald-400/40">
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                    <span>Choose file</span>
                  </label>
                  <div className="text-xs text-slate-400">
                    PDF or DOCX files are supported. Max ~10MB recommended.
                  </div>
                </div>
                <div className="text-xs text-slate-300">
                  {uploadedResume ? (
                    <span>
                      Selected:{" "}
                      <span className="font-medium text-emerald-300">
                        {uploadedResume.file.name}
                      </span>{" "}
                      ({Math.round(uploadedResume.file.size / 1024)} KB)
                    </span>
                  ) : (
                    <span>No file selected yet.</span>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  value={pastedResumeText}
                  onChange={(e) => setPastedResumeText(e.target.value)}
                  placeholder="Paste your resume content here. Include all sections: contact information, professional summary, work experience, education, skills, etc."
                  className="min-h-[200px] w-full resize-none rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none ring-0 transition placeholder:text-slate-500 focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-500/40"
                />
                <p className="text-xs text-slate-400">
                  Paste the complete text content of your resume. The AI will
                  reword and format it to be ATS-friendly and professional.
                </p>
              </div>
            )}
          </div>

          {/* Job Description */}
          <div className="space-y-2">
            <label
              htmlFor="job-description"
              className="text-sm font-medium text-slate-200"
            >
              Job description
            </label>
            <textarea
              id="job-description"
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              placeholder="Paste the job description here. Qfix Resume will soon analyze this and highlight how to adapt your resume."
              className="min-h-[150px] w-full resize-none rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-100 outline-none ring-0 transition placeholder:text-slate-500 focus:border-emerald-400/70 focus:ring-2 focus:ring-emerald-500/40"
            />
            <p className="text-xs text-slate-400">
              We don&apos;t store your resume or job description. Tailoring is
              done via a secure AI API, and this demo keeps everything tied to
              your current session. The AI will create an ATS-friendly, clean,
              and professional resume tailored to the job description.
            </p>
          </div>

          {/* Actions */}
          <div className="mt-2 flex flex-wrap items-center gap-3 border-t border-slate-800 pt-4">
            <button
              type="button"
              disabled={
                (!uploadedResume && !pastedResumeText.trim()) ||
                !jobDescription.trim() ||
                isTailoring
              }
              onClick={handleTailorClick}
              className="inline-flex items-center justify-center rounded-full bg-slate-50 px-4 py-2 text-sm font-semibold text-slate-950 shadow-sm transition hover:bg-slate-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {isTailoring ? "Tailoring resume..." : "Tailor resume with AI"}
            </button>

            {uploadedResume && (
              <a
                href={uploadedResume.url}
                download={uploadedResume.file.name}
                className="inline-flex items-center justify-center rounded-full border border-slate-600 bg-slate-900 px-4 py-2 text-sm font-medium text-slate-50 shadow-sm transition hover:border-emerald-400/80 hover:text-emerald-200"
              >
                Download uploaded resume
              </a>
            )}
            {error && (
              <p className="basis-full text-xs font-medium text-red-400">
                {error}
              </p>
            )}
          </div>
        </section>
      </main>

      {/* Preview section */}
      <section className="mx-auto flex max-w-6xl flex-col gap-4 px-6 pb-12 md:px-10">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Resume preview
            </h2>
            <p className="text-xs text-slate-400">
              {usePastedText && pastedResumeText
                ? "Your pasted resume content is ready. The AI tailored version will appear below after processing."
                : "See your uploaded resume on the left and, when available, the AI tailored version below."}
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70 shadow-lg shadow-slate-950/70">
          {usePastedText && pastedResumeText ? (
            <div className="p-4">
              <div className="mb-3 space-y-2 text-xs text-slate-300">
                <p className="font-medium text-slate-100">Pasted resume content</p>
                <p>
                  Characters:{" "}
                  <span className="font-medium text-emerald-300">
                    {pastedResumeText.length.toLocaleString()}
                  </span>
                </p>
                <p className="text-slate-400">
                  Your resume content is ready for tailoring. The AI will create
                  an ATS-friendly version based on the job description.
                </p>
              </div>
              <div className="max-h-96 overflow-auto rounded-xl border border-slate-800 bg-slate-900/80 p-3 text-xs font-mono leading-relaxed text-slate-100">
                <pre className="whitespace-pre-wrap break-words">
                  {pastedResumeText}
                </pre>
              </div>
            </div>
          ) : uploadedResume ? (
            <div className="flex flex-col gap-4 p-4 md:flex-row">
              <div className="w-full space-y-2 text-xs text-slate-300 md:max-w-xs">
                <p className="font-medium text-slate-100">File details</p>
                <p>
                  Name:{" "}
                  <span className="font-medium text-emerald-300">
                    {uploadedResume.file.name}
                  </span>
                </p>
                <p>
                  Type:{" "}
                  <span className="font-mono">
                    {uploadedResume.file.type || "Unknown"}
                  </span>
                </p>
                <p>Size: {Math.round(uploadedResume.file.size / 1024)} KB</p>
                {!isPdf && (
                  <p className="mt-1 text-xs text-slate-400">
                    Preview is available for PDF files. DOC/DOCX files can still
                    be downloaded using the button above.
                  </p>
                )}
              </div>

              <div className="h-[320px] flex-1 rounded-xl border border-slate-800 bg-slate-900/80">
                {isPdf ? (
                  <iframe
                    src={uploadedResume.url}
                    title="Uploaded resume preview"
                    className="h-full w-full rounded-xl border-none"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center px-4 text-center text-xs text-slate-400">
                    Preview is only available for PDF resumes. Your DOC/DOCX
                    file is ready to download using the button above.
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-52 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-slate-400">
              <p className="font-medium text-slate-200">
                No resume provided yet.
              </p>
              <p>
                Upload a PDF or DOCX resume, or paste your resume content above
                to get started.
              </p>
            </div>
          )}
        </div>

        {tailoredResumeText && (
          <div className="mt-6 space-y-3 rounded-2xl border border-emerald-700/70 bg-slate-950/60 p-4 shadow-lg shadow-emerald-900/60">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-emerald-300">
                  AI-tailored resume
                </h3>
                <p className="text-xs text-slate-400">
                  Your professionally formatted resume is ready. Download as PDF
                  or view the LaTeX source code below.
                </p>
              </div>
              {tailoredDownloadUrl && (
                <a
                  href={tailoredDownloadUrl}
                  download={tailoredFilename || "qfix-tailored-resume.pdf"}
                  className="inline-flex items-center justify-center rounded-full border border-emerald-500/70 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/20"
                >
                  Download tailored resume (PDF)
                </a>
              )}
            </div>
            {tailoredDownloadUrl && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-2">
                <iframe
                  src={tailoredDownloadUrl}
                  title="Tailored resume PDF preview"
                  className="h-[600px] w-full rounded-lg"
                />
              </div>
            )}
            <details className="mt-2">
              <summary className="cursor-pointer text-xs font-medium text-slate-400 hover:text-slate-300">
                View LaTeX source code
              </summary>
              <div className="mt-2 max-h-96 overflow-auto rounded-xl border border-slate-800 bg-slate-950/80 p-3 text-xs font-mono leading-relaxed text-slate-100">
                <pre className="whitespace-pre-wrap break-words">
                  {tailoredResumeText}
                </pre>
              </div>
            </details>
          </div>
        )}
      </section>
    </div>
  );
}
