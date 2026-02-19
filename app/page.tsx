"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "./auth-context";
import { RESUME_HTML_STYLES, latexToHtml } from "@/lib/latex";
/** Fetches limit status from server so it matches enforcement (no client Firestore read). */
async function fetchLimitStatus(userId: string): Promise<{ remaining: number; isSpecial: boolean }> {
  const res = await fetch("/api/rate-limit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, action: "check" }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to load limit status.");
  }
  const data = await res.json();
  return {
    remaining: typeof data.remaining === "number" ? data.remaining : 0,
    isSpecial: Boolean(data.isSpecial),
  };
}

type UploadedResume = {
  file: File;
  url: string;
};

export default function Home() {
  const { user, loading, signInWithGoogle, logout } = useAuth();

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
  const [tailoredFilename, setTailoredFilename] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [limitStatus, setLimitStatus] = useState<{
    remaining: number;
    isSpecial: boolean;
  } | null>(null);
  const [checkingLimit, setCheckingLimit] = useState(false);
  const [showContactPopup, setShowContactPopup] = useState(false);
  const [latexCopied, setLatexCopied] = useState(false);

  useEffect(() => {
    return () => {
      if (uploadedResume?.url) {
        URL.revokeObjectURL(uploadedResume.url);
      }
    };
  }, [uploadedResume]);

  // Load user limit status from server when user changes (matches enforcement)
  useEffect(() => {
    if (user?.uid) {
      fetchLimitStatus(user.uid)
        .then((status) => {
          setLimitStatus({
            remaining: status.remaining,
            isSpecial: status.isSpecial,
          });
        })
        .catch(() => {
          // Don't show "limit reached" when check failed (e.g. server error)
          setLimitStatus(null);
        });
    } else {
      setLimitStatus(null);
    }
  }, [user]);

  // Clear all form data and uploads when user logs out so next login starts fresh
  useEffect(() => {
    if (!user) {
      setUploadedResume((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return null;
      });
      setPastedResumeText("");
      setUsePastedText(false);
      setJobDescription("");
      setTailoredResumeText(null);
      setTailoredFilename(null);
      setError(null);
      setShowContactPopup(false);
    }
  }, [user]);

  const tailoredHtml = useMemo(() => {
    if (!tailoredResumeText) return null;
    try {
      return latexToHtml(tailoredResumeText);
    } catch {
      return null;
    }
  }, [tailoredResumeText]);

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
  };

  const handleTailorClick = async () => {
    if ((!uploadedResume && !pastedResumeText.trim()) || !jobDescription.trim()) {
      return;
    }

    if (!user?.uid) {
      setError("Please sign in to use this service.");
      return;
    }

    // Check conversion limit from server (same source as enforcement)
    setCheckingLimit(true);
    const limitStatus = await fetchLimitStatus(user.uid);
    setCheckingLimit(false);

    if (!limitStatus.isSpecial && limitStatus.remaining === 0) {
      setError("You have reached your daily limit of 1 conversion. Please try again tomorrow.");
      return;
    }

    setIsTailoring(true);
    setError(null);
    setTailoredResumeText(null);
    setTailoredFilename(null);

    try {
      const formData = new FormData();
      if (uploadedResume && !usePastedText) {
        formData.append("resume", uploadedResume.file);
      } else if (pastedResumeText.trim()) {
        formData.append("resumeText", pastedResumeText.trim());
      }
      formData.append("jobDescription", jobDescription);
      formData.append("userId", user.uid);

      const response = await fetch("/api/tailor", {
        method: "POST",
        body: formData,
      });

      // Safely parse JSON if available; fall back to text otherwise
      let data: any = null;
      let fallbackText: string | null = null;
      const contentType = response.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        try {
          data = await response.json();
        } catch {
          // If JSON parsing fails, we'll try reading as plain text below
        }
      }

      if (!data) {
        try {
          fallbackText = await response.text();
        } catch {
          fallbackText = null;
        }
      }

      if (!response.ok) {
        const message =
          (data && typeof data.error === "string" && data.error) ||
          fallbackText ||
          "Failed to tailor resume.";
        throw new Error(message);
      }

      if (!data) {
        throw new Error("Unexpected server response from tailor API.");
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

      // Refresh limit status from server (conversion was recorded atomically by tailor API)
      if (user?.uid) {
        fetchLimitStatus(user.uid).then((updatedStatus) => {
          setLimitStatus({
            remaining: updatedStatus.remaining,
            isSpecial: updatedStatus.isSpecial,
          });
          // Show contact popup when user just used their daily generation (0 remaining, not special)
          if (updatedStatus.remaining === 0 && !updatedStatus.isSpecial) {
            setShowContactPopup(true);
          }
        });
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

  const handleOpenPrintView = useCallback(() => {
    if (!tailoredHtml) return;
    const win = window.open("", "_blank");
    if (!win) return;
    const title = tailoredFilename || "qfix-tailored-resume";
    win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
${RESUME_HTML_STYLES}
  </style>
</head>
<body>
${tailoredHtml}
<script>
  window.onload = function () {
    window.focus();
    window.print();
  };
</script>
</body>
</html>`);
    win.document.close();
  }, [tailoredHtml, tailoredFilename]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50">
        <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center gap-6 px-4 py-8 text-center sm:px-6 sm:py-10">
          <div className="relative">
            <div className="h-16 w-16 animate-spin rounded-full border-4 border-slate-700 border-t-emerald-400"></div>
            <div className="absolute inset-0 h-16 w-16 animate-ping rounded-full border-4 border-emerald-400/20"></div>
          </div>
          <p className="text-sm font-medium text-slate-300">Loading Qfix Resume...</p>
        </main>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50">
        {/* Animated background elements */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute -top-40 -right-40 h-80 w-80 rounded-full bg-emerald-500/10 blur-3xl animate-pulse"></div>
          <div className="absolute -bottom-40 -left-40 h-80 w-80 rounded-full bg-cyan-500/10 blur-3xl animate-pulse delay-1000"></div>
        </div>

        <main className="relative mx-auto flex min-h-[100dvh] max-w-4xl flex-col items-center justify-center gap-6 px-4 py-8 text-center sm:gap-8 sm:px-6 sm:py-12">
          {/* Logo/Brand */}
          <div className="space-y-4 animate-fade-in">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-xs font-semibold text-emerald-300 shadow-lg shadow-emerald-500/20">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400"></span>
              Qfix Resume
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-50 sm:text-5xl md:text-6xl lg:text-7xl">
              Tailor Your Resume
              <span className="block bg-gradient-to-r from-emerald-400 via-cyan-400 to-sky-400 bg-clip-text text-transparent">
                To Every Job
              </span>
            </h1>
            <p className="mx-auto max-w-2xl text-base leading-relaxed text-slate-300 sm:text-lg md:text-xl">
              Transform your resume into a perfect match for any job description with AI-powered tailoring. 
              Get ATS-friendly, professional resumes in seconds.
            </p>
          </div>

          {/* Features */}
          <div className="grid w-full max-w-2xl grid-cols-1 gap-3 px-1 sm:grid-cols-3 sm:gap-4 animate-fade-in delay-200">
            <div className="rounded-xl border border-slate-800/50 bg-slate-900/40 p-4 backdrop-blur-sm">
              <div className="mb-2 text-2xl">⚡</div>
              <div className="text-sm font-semibold text-slate-200">Lightning Fast</div>
              <div className="mt-1 text-xs text-slate-400">Get results in seconds</div>
            </div>
            <div className="rounded-xl border border-slate-800/50 bg-slate-900/40 p-4 backdrop-blur-sm">
              <div className="mb-2 text-2xl">🎯</div>
              <div className="text-sm font-semibold text-slate-200">ATS Optimized</div>
              <div className="mt-1 text-xs text-slate-400">Pass applicant tracking</div>
            </div>
            <div className="rounded-xl border border-slate-800/50 bg-slate-900/40 p-4 backdrop-blur-sm">
              <div className="mb-2 text-2xl">🔒</div>
              <div className="text-sm font-semibold text-slate-200">Secure & Private</div>
              <div className="mt-1 text-xs text-slate-400">Your data stays safe</div>
            </div>
          </div>

          {/* Sign In Button */}
          <div className="space-y-4 animate-fade-in delay-300 w-full max-w-sm">
            <button
              type="button"
              onClick={signInWithGoogle}
              className="group relative inline-flex min-h-[48px] w-full items-center justify-center gap-3 overflow-hidden rounded-2xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-6 py-4 text-base font-semibold text-slate-950 shadow-2xl shadow-emerald-500/30 transition-all duration-300 hover:scale-[1.02] hover:shadow-emerald-500/50 active:scale-[0.98] sm:min-h-0 sm:w-auto sm:px-8 sm:hover:scale-105"
            >
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              <span>Continue with Google</span>
              <div className="absolute inset-0 -z-10 bg-gradient-to-r from-emerald-600 to-cyan-600 opacity-0 transition-opacity duration-300 group-hover:opacity-100"></div>
            </button>
            <p className="text-xs text-slate-400">
              By continuing, you agree to our Terms of Service and Privacy Policy
            </p>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-50">
      {/* Contact popup: shown after user uses their daily generation */}
      {showContactPopup && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]" role="dialog" aria-modal="true" aria-labelledby="contact-popup-title">
          <button
            type="button"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowContactPopup(false)}
            aria-label="Close"
          />
          <div className="relative max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-2xl border border-slate-700/50 bg-slate-900/95 p-4 shadow-2xl sm:max-h-[90vh] sm:p-6">
            <div className="mb-4 flex items-center justify-between">
              <h2 id="contact-popup-title" className="text-lg font-semibold text-slate-100">
                Daily limit used
              </h2>
            <button
              type="button"
              onClick={() => setShowContactPopup(false)}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 touch-manipulation"
              aria-label="Close"
            >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <p className="text-sm text-slate-300">
              You&apos;ve used your free conversion for today. Need more? Email{" "}
              <a
                href="mailto:namanver.2002@gmail.com"
                className="font-medium text-emerald-400 underline decoration-emerald-500/50 underline-offset-2 hover:text-emerald-300"
              >
                namanver.2002@gmail.com
              </a>{" "}
              to apply for the unlimited generation tier.
            </p>
            <button
              type="button"
              onClick={() => setShowContactPopup(false)}
              className="mt-5 min-h-[48px] w-full touch-manipulation rounded-xl bg-emerald-500/20 px-4 py-3 text-sm font-semibold text-emerald-300 transition-colors hover:bg-emerald-500/30 active:bg-emerald-500/30"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Header with user profile */}
      <header className="sticky top-0 z-50 border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-xl pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 shrink items-center gap-2">
            <div className="inline-flex shrink-0 items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400"></span>
              <span className="truncate">Qfix Resume</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-4">
            {limitStatus && (
              <div className="flex items-center gap-2 rounded-lg border border-slate-800/50 bg-slate-900/40 px-2.5 py-1.5 min-h-[44px] sm:px-3 sm:min-h-0">
                {limitStatus.isSpecial ? (
                  <>
                    <svg className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                    </svg>
                    <span className="text-xs font-medium text-emerald-300">Unlimited</span>
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-xs font-medium text-slate-300">
                      <span className="sm:hidden">{limitStatus.remaining > 0 ? `${limitStatus.remaining} left` : "Limit reached"}</span>
                      <span className="hidden sm:inline">{limitStatus.remaining > 0 
                        ? `${limitStatus.remaining} conversion${limitStatus.remaining === 1 ? '' : 's'} left today`
                        : "Limit reached"}</span>
                    </span>
                  </>
                )}
              </div>
            )}
            <div className="hidden items-center gap-3 sm:flex">
              {user.photoURL && (
                <img
                  src={user.photoURL}
                  alt={user.displayName || "User"}
                  className="h-8 w-8 rounded-full border-2 border-slate-700"
                />
              )}
              <div className="text-right">
                <div className="text-xs font-medium text-slate-200">
                  {user.displayName || "User"}
                </div>
                <div className="text-xs text-slate-400">
                  {user.email}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={logout}
              className="inline-flex min-h-[44px] min-w-[44px] touch-manipulation items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900/50 px-3 py-2.5 text-xs font-medium text-slate-300 transition-all hover:border-emerald-500/50 hover:bg-slate-800/50 hover:text-emerald-300 active:bg-slate-800 sm:px-4"
            >
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              <span className="hidden sm:inline">Sign out</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100dvh-65px)] max-w-7xl flex-col gap-6 px-4 py-6 sm:gap-8 sm:px-6 sm:py-8 md:px-10 lg:min-h-[calc(100vh-73px)] lg:flex-row lg:items-start lg:gap-12 lg:py-12">
        {/* Left: Hero / Intro */}
        <section className="flex flex-1 flex-col gap-6 sm:gap-8 lg:sticky lg:top-[73px] lg:max-h-[calc(100vh-73px)]">
          <div className="space-y-4 sm:space-y-6">
            <div className="space-y-3 sm:space-y-4">
              <h1 className="text-balance text-3xl font-bold tracking-tight text-slate-50 sm:text-4xl md:text-5xl lg:text-6xl">
                Tailor your resume
                <span className="block bg-gradient-to-r from-emerald-400 via-cyan-400 to-sky-400 bg-clip-text text-transparent">
                  to every job description.
                </span>
              </h1>
              <p className="max-w-xl text-pretty text-sm leading-relaxed text-slate-300 sm:text-base md:text-lg">
                Qfix Resume helps you instantly adapt your resume to match any
                role. Upload your resume, paste the job description, and get a
                targeted version ready to send.
              </p>
            </div>

            {/* Quick stats or tips */}
            <div className="rounded-xl border border-slate-800/50 bg-gradient-to-br from-slate-900/50 to-slate-950/50 p-3 backdrop-blur-sm sm:p-4">
              <div className="flex items-start gap-3">
                <div className="rounded-lg bg-emerald-500/20 p-2">
                  <svg className="h-5 w-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="flex-1 space-y-1">
                  <div className="text-sm font-semibold text-slate-200">Pro Tip</div>
                  <p className="text-xs leading-relaxed text-slate-400">
                    Include quantifiable achievements in your resume for better results. The AI will highlight and enhance them based on the job requirements.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Right: Upload & Job Description */}
        <section className="flex flex-1 flex-col gap-4 rounded-2xl border border-slate-800/50 bg-gradient-to-br from-slate-900/80 to-slate-950/80 p-4 shadow-2xl shadow-slate-950/80 backdrop-blur-xl sm:gap-6 sm:p-6 md:p-8">
          <div className="space-y-2 sm:space-y-3">
            <div className="flex items-center gap-2">
              <div className="rounded-lg bg-emerald-500/20 p-1.5">
                <svg className="h-5 w-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-slate-50 sm:text-xl">
                Get Started
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400 sm:text-sm">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-semibold text-emerald-300">1</span>
              <span>Upload or paste</span>
              <span className="text-slate-600">·</span>
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-slate-400">2</span>
              <span>Job description</span>
              <span className="text-slate-600">·</span>
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-semibold text-slate-400">3</span>
              <span>Get resume</span>
            </div>
          </div>

          {/* Resume Input - File Upload or Paste */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-200">
                Your resume
              </label>
              <div className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-slate-800/50 bg-slate-950/60 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setUsePastedText(false);
                    setPastedResumeText("");
                  }}
                  className={`min-h-[36px] text-xs px-3 py-2 rounded-md font-medium transition-all touch-manipulation ${
                    !usePastedText
                      ? "bg-emerald-500/20 text-emerald-300 shadow-sm"
                      : "text-slate-400 hover:text-slate-300"
                  }`}
                >
                  Upload
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setUsePastedText(true);
                    setUploadedResume(null);
                  }}
                  className={`min-h-[36px] text-xs px-3 py-2 rounded-md font-medium transition-all touch-manipulation ${
                    usePastedText
                      ? "bg-emerald-500/20 text-emerald-300 shadow-sm"
                      : "text-slate-400 hover:text-slate-300"
                  }`}
                >
                  Paste
                </button>
              </div>
            </div>

            {!usePastedText ? (
              <div className="flex flex-col gap-4 rounded-xl border-2 border-dashed border-slate-700/50 bg-slate-950/40 p-6 text-sm transition-colors hover:border-emerald-500/30">
                <div className="flex flex-col items-center gap-4 text-center">
                  <label className="group relative inline-flex cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-6 py-3 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/30 transition-all hover:scale-105 hover:shadow-emerald-500/50 active:scale-95">
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                      className="hidden"
                      onChange={handleFileChange}
                    />
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    <span>Choose File</span>
                  </label>
                  <div className="text-xs text-slate-400">
                    PDF or DOCX files · Max ~10MB
                  </div>
                </div>
                {uploadedResume && (
                  <div className="mt-2 flex items-center gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
                    <svg className="h-5 w-5 flex-shrink-0 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div className="flex-1 min-w-0">
                      <div className="truncate text-sm font-medium text-emerald-300">
                        {uploadedResume.file.name}
                      </div>
                      <div className="text-xs text-slate-400">
                        {Math.round(uploadedResume.file.size / 1024)} KB
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <textarea
                  value={pastedResumeText}
                  onChange={(e) => setPastedResumeText(e.target.value)}
                  placeholder="Paste your resume content here. Include all sections: contact information, professional summary, work experience, education, skills, etc."
                  className="min-h-[180px] w-full resize-none rounded-xl border border-slate-700/50 bg-slate-950/60 px-4 py-3 text-base text-slate-100 outline-none ring-0 transition-all placeholder:text-slate-500 focus:border-emerald-500/50 focus:bg-slate-950/80 focus:ring-2 focus:ring-emerald-500/20 sm:min-h-[200px] sm:text-sm"
                />
                <p className="flex items-center gap-2 text-xs text-slate-400">
                  <svg className="h-4 w-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Paste the complete text content. The AI will reword and format it to be ATS-friendly and professional.
                </p>
              </div>
            )}
          </div>

          {/* Job Description */}
          <div className="space-y-2">
            <label
              htmlFor="job-description"
              className="flex items-center gap-2 text-sm font-semibold text-slate-200"
            >
              <svg className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 13.255A23.931 23.931 0 0112 15c-3.183 0-6.22-.62-9-1.745M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2m4 6h.01M5 20h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Job Description
            </label>
            <textarea
              id="job-description"
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              placeholder="Paste the job description here. Qfix Resume will analyze this and tailor your resume accordingly."
              className="min-h-[140px] w-full resize-none rounded-xl border border-slate-700/50 bg-slate-950/60 px-4 py-3 text-base text-slate-100 outline-none ring-0 transition-all placeholder:text-slate-500 focus:border-emerald-500/50 focus:bg-slate-950/80 focus:ring-2 focus:ring-emerald-500/20 sm:min-h-[150px] sm:text-sm"
            />
            <p className="flex items-start gap-2 text-xs text-slate-400">
              <svg className="h-4 w-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <span>Your data is processed securely and not stored. The AI creates an ATS-friendly, professional resume tailored to this job description.</span>
            </p>
          </div>

          {/* Actions */}
          <div className="mt-4 flex flex-col gap-3 border-t border-slate-800/50 pt-6">
            {limitStatus && !limitStatus.isSpecial && (
              <div className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2.5 sm:px-4 ${
                limitStatus.remaining > 0
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-amber-500/30 bg-amber-500/10"
              }`}>
                <div className="flex items-center gap-2">
                  {limitStatus.remaining > 0 ? (
                    <>
                      <svg className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="text-xs font-medium text-emerald-300">
                        {limitStatus.remaining} conversion{limitStatus.remaining === 1 ? '' : 's'} remaining today
                      </span>
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <span className="text-xs font-medium text-amber-300">
                        Daily limit reached. Try again tomorrow!
                      </span>
                    </>
                  )}
                </div>
                {limitStatus.remaining === 0 && (
                  <span className="text-xs text-amber-400/70">
                    Resets at midnight
                  </span>
                )}
              </div>
            )}

            {/* Contact: apply for unlimited tier */}
            {limitStatus && !limitStatus.isSpecial && (
              <div className="rounded-lg border border-slate-700/50 bg-slate-900/40 px-3 py-2.5 sm:px-4 sm:py-3">
                <p className="text-xs leading-relaxed text-slate-300">
                  Exceeded your daily limit? Email{" "}
                  <a
                    href="mailto:namanver.2002@gmail.com"
                    className="font-medium text-emerald-400 underline decoration-emerald-500/50 underline-offset-2 hover:text-emerald-300"
                  >
                    namanver.2002@gmail.com
                  </a>{" "}
                  to apply for the unlimited generation tier.
                </p>
              </div>
            )}

            <button
              type="button"
              disabled={
                (!uploadedResume && !pastedResumeText.trim()) ||
                !jobDescription.trim() ||
                isTailoring ||
                checkingLimit ||
                (limitStatus !== null && !limitStatus.isSpecial && limitStatus.remaining === 0)
              }
              onClick={handleTailorClick}
              className="group relative inline-flex min-h-[48px] w-full touch-manipulation items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r from-emerald-500 to-cyan-500 px-6 py-3.5 text-sm font-semibold text-slate-950 shadow-lg shadow-emerald-500/30 transition-all disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100 hover:scale-[1.02] hover:shadow-emerald-500/50 active:scale-[0.98] sm:w-auto"
            >
              {isTailoring ? (
                <>
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-slate-950 border-t-transparent"></div>
                  <span>Tailoring your resume...</span>
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <span>Tailor Resume with AI</span>
                </>
              )}
            </button>

            {uploadedResume && (
              <a
                href={uploadedResume.url}
                download={uploadedResume.file.name}
                className="inline-flex min-h-[44px] w-full touch-manipulation items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3 text-sm font-medium text-slate-200 transition-all hover:border-emerald-500/50 hover:bg-slate-800/50 hover:text-emerald-300 active:bg-slate-800/50 sm:w-auto sm:py-2.5"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                Download Original Resume
              </a>
            )}
            {error && (
              <div className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
                <svg className="h-5 w-5 flex-shrink-0 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm font-medium text-red-300">{error}</p>
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Preview section */}
      <section className="mx-auto flex max-w-7xl flex-col gap-4 px-4 pb-12 sm:gap-6 sm:px-6 sm:pb-16 md:px-10">
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-100 sm:text-xl">
              <svg className="h-5 w-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
              </svg>
              Resume Preview
            </h2>
            <p className="text-sm text-slate-400">
              {usePastedText && pastedResumeText
                ? "Your pasted resume content is ready. The AI tailored version will appear below after processing."
                : "See your uploaded resume and the AI tailored version below."}
            </p>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-800/50 bg-gradient-to-br from-slate-900/80 to-slate-950/80 shadow-2xl shadow-slate-950/80 backdrop-blur-xl">
          {usePastedText && pastedResumeText ? (
            <div className="p-4 sm:p-6">
              <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-slate-100">Pasted Resume Content</p>
                  <p className="text-xs text-slate-400">
                    {pastedResumeText.length.toLocaleString()} characters
                  </p>
                </div>
                <div className="rounded-lg bg-emerald-500/20 px-3 py-1.5">
                  <span className="text-xs font-semibold text-emerald-300">Ready</span>
                </div>
              </div>
              <div className="max-h-96 overflow-auto rounded-xl border border-slate-800/50 bg-slate-950/60 p-4 text-xs font-mono leading-relaxed text-slate-200">
                <pre className="whitespace-pre-wrap break-words">
                  {pastedResumeText}
                </pre>
              </div>
            </div>
          ) : uploadedResume ? (
            <div className="flex flex-col gap-4 p-4 sm:gap-6 sm:p-6 md:flex-row">
              <div className="w-full space-y-3 rounded-xl border border-slate-800/50 bg-slate-950/60 p-4 md:max-w-xs">
                <p className="text-sm font-semibold text-slate-100">File Details</p>
                <div className="space-y-2 text-xs">
                  <div>
                    <span className="text-slate-400">Name:</span>
                    <p className="mt-0.5 truncate font-medium text-emerald-300">
                      {uploadedResume.file.name}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-400">Type:</span>
                    <p className="mt-0.5 font-mono text-slate-300">
                      {uploadedResume.file.type || "Unknown"}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-400">Size:</span>
                    <p className="mt-0.5 text-slate-300">
                      {Math.round(uploadedResume.file.size / 1024)} KB
                    </p>
                  </div>
                </div>
                {!isPdf && (
                  <div className="mt-3 rounded-lg bg-amber-500/10 border border-amber-500/20 p-2">
                    <p className="text-xs text-amber-300">
                      Preview available for PDF files. DOC/DOCX files can be downloaded above.
                    </p>
                  </div>
                )}
              </div>

              <div className="h-[400px] flex-1 rounded-xl border border-slate-800/50 bg-slate-950/60 overflow-hidden">
                {isPdf ? (
                  <iframe
                    src={uploadedResume.url}
                    title="Uploaded resume preview"
                    className="h-full w-full border-none"
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                    <div className="rounded-full bg-slate-800 p-4">
                      <svg className="h-8 w-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-slate-300">
                      Preview available for PDF files
                    </p>
                    <p className="text-xs text-slate-400">
                      Your DOC/DOCX file is ready to download
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-64 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
              <div className="rounded-full bg-slate-800/50 p-4">
                <svg className="h-10 w-10 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-200">
                  No resume provided yet
                </p>
                <p className="text-xs text-slate-400">
                  Upload a PDF or DOCX resume, or paste your resume content above to get started
                </p>
              </div>
            </div>
          )}
        </div>

        {tailoredResumeText && (
          <div className="mt-4 space-y-4 rounded-2xl border-2 border-emerald-500/30 bg-gradient-to-br from-emerald-950/30 via-slate-950/80 to-slate-950/80 p-4 shadow-2xl shadow-emerald-900/30 backdrop-blur-xl sm:mt-6 sm:p-6">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg bg-emerald-500/20 p-1.5">
                    <svg className="h-5 w-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-lg font-bold text-emerald-300">
                    AI-Tailored Resume
                  </h3>
                </div>
                <p className="text-sm text-slate-300">
                  Your professionally formatted resume is ready. Preview it below and use your browser&apos;s &quot;Save as PDF&quot; option, or view the LaTeX source code.
                </p>
              </div>
              {tailoredHtml && (
                <button
                  type="button"
                  onClick={handleOpenPrintView}
                  className="inline-flex min-h-[44px] w-full touch-manipulation items-center justify-center gap-2 rounded-xl border border-emerald-500/50 bg-emerald-500/20 px-5 py-3 text-sm font-semibold text-emerald-200 shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-500/30 hover:shadow-emerald-500/30 active:bg-emerald-500/30 sm:w-auto sm:py-2.5"
                >
                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Open printable view / Save as PDF
                </button>
              )}
            </div>
            {tailoredHtml && (
              <div className="rounded-xl border border-slate-800/50 bg-slate-950/60 overflow-hidden">
                <div className="h-[55dvh] w-full min-h-[320px] overflow-auto bg-white text-black sm:h-[500px] md:h-[600px] lg:h-[700px]">
                  <style
                    // Scoped styles for the preview container
                    dangerouslySetInnerHTML={{ __html: RESUME_HTML_STYLES }}
                  />
                  <div
                    className="mx-auto max-w-[8.5in] px-8 py-6"
                    dangerouslySetInnerHTML={{ __html: tailoredHtml }}
                  />
                </div>
              </div>
            )}
            <details className="group">
              <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800/50 bg-slate-900/40 px-3 py-2.5 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800/50 hover:text-slate-200 [&::-webkit-details-marker]:hidden sm:gap-3 sm:px-4 sm:py-3">
                <span className="flex items-center gap-2">
                  <svg className="h-4 w-4 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  View LaTeX Source Code
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (tailoredResumeText) {
                      void navigator.clipboard.writeText(tailoredResumeText);
                      setLatexCopied(true);
                      setTimeout(() => setLatexCopied(false), 2000);
                    }
                  }}
                  className="flex min-h-[40px] shrink-0 touch-manipulation items-center gap-1.5 rounded-lg border border-slate-700/50 bg-slate-800/50 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-emerald-500/50 hover:bg-slate-800 hover:text-emerald-300 active:bg-slate-800 sm:py-1.5"
                >
                  {latexCopied ? (
                    <>
                      <svg className="h-4 w-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </>
                  ) : (
                    <>
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy
                    </>
                  )}
                </button>
              </summary>
              <div className="mt-3 max-h-96 overflow-auto rounded-xl border border-slate-800/50 bg-slate-950/80 p-4 text-xs font-mono leading-relaxed text-slate-200">
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
