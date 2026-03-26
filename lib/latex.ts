/**
 * Post-process raw LLM LaTeX output: strip markdown fences, remove document
 * boilerplate, and fix common issues so the result is polished, valid resume body LaTeX.
 */
export function polishLaTeX(raw: string): string {
  let s = raw.trim();

  // Strip markdown code fences (e.g. ```latex ... ``` or ``` ... ```)
  const fenceMatch = s.match(/^```(?:latex|tex)?\s*\n?([\s\S]*?)\n?```$/);
  if (fenceMatch) {
    s = fenceMatch[1].trim();
  }

  // Remove document-level boilerplate (we only want body content)
  s = s.replace(/\\documentclass\[.*?\]\{.*?\}[\r\n]*/g, "");
  s = s.replace(/\\documentclass\{.*?\}[\r\n]*/g, "");
  s = s.replace(/\\usepackage(\[[^\]]*])?\{[^}]+\}[\r\n]*/g, "");
  s = s.replace(/\\newcommand\{\\[^}]+\}\{[^}]*\}[\r\n]*/g, "");
  s = s.replace(/\\begin\{document\}[\r\n]*/g, "");
  s = s.replace(/\\end\{document\}[\r\n]*/g, "");

  // Collapse duplicate column separators in tabular (&& -> &)
  s = s.replace(/&\s*&/g, "&");

  // Remove empty itemize blocks (often caused by missing content)
  s = s.replace(
    /\\begin\{itemize\}\s*(?:\\itemsep\s*-?\d+pt\s*\{\}\s*)?\\end\{itemize\}\s*/g,
    "",
  );

  // Remove empty rSection blocks (including ones with only size commands)
  s = s.replace(
    /\\normalsize\s*\\begin\{rSection\}\{[^}]+\}\s*(?:\\footnotesize\s*)?\\end\{rSection\}\s*/g,
    "",
  );
  s = s.replace(
    /\\begin\{rSection\}\{[^}]+\}\s*(?:\\footnotesize\s*)?\\end\{rSection\}\s*/g,
    "",
  );

  // Ensure itemize has \itemsep -2pt {} for compact bullets (match sample), only if missing
  s = s.replace(
    /\\begin\{itemize\}\s*\n(?!\s*\\itemsep)/g,
    "\\begin{itemize}\n    \\itemsep -2pt {} \n",
  );

  // Normalize whitespace: no trailing spaces, single blank lines max
  s = s
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
  s = s.replace(/\n{3,}/g, "\n\n");

  return s.trim();
}

export const RESUME_HTML_STYLES = `
  @page {
    margin: 0.75in;
    size: A4;
  }
  body {
    font-family: 'Times New Roman', Times, serif;
    font-size: 10.5pt;
    line-height: 1.25;
    color: #000;
    max-width: 8.5in;
    margin: 0 auto;
    padding: 0;
  }
  .center {
    text-align: center;
    margin-bottom: 8pt;
  }
  .center strong,
  .resume-name {
    font-size: 18pt;
    font-weight: bold;
  }
  .center.address p {
    margin: 1pt 0;
  }
  .section-title {
    font-size: 12pt;
    font-weight: bold;
    color: #000000;
    margin-top: 8pt;
    margin-bottom: 4pt;
    border-bottom: 1px solid #000000;
    padding-bottom: 2pt;
    text-transform: uppercase;
    letter-spacing: 0.3pt;
  }
  .resume-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12pt;
    width: 100%;
    margin: 2pt 0;
  }
  .resume-row > span:first-child {
    min-width: 0;
    flex: 1;
  }
  .resume-row > span:last-child {
    white-space: nowrap;
    text-align: right;
    flex-shrink: 0;
  }
  .resume-list {
    margin: 2pt 0;
    padding-left: 16pt;
    list-style-type: disc;
  }
  .resume-list li {
    margin: 1pt 0;
    padding-left: 2pt;
  }
  p {
    margin: 2pt 0;
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
    margin: 2pt 0;
    font-size: inherit;
  }
  .resume-table td {
    padding: 1pt 8pt 1pt 0;
    vertical-align: top;
  }
  .resume-table tr td:first-child {
    font-weight: bold;
    white-space: nowrap;
    width: 1%;
  }
`;

export function latexToHtml(latexCode: string): string {
  // Normalize and strip common LaTeX boilerplate if the model added it
  let html = latexCode;

  // Remove documentclass / usepackage / begin/end{document} lines completely
  html = html.replace(/\\documentclass\[.*?\]\{.*?\}[\r\n]*/g, "");
  html = html.replace(/\\documentclass\{.*?\}[\r\n]*/g, "");
  html = html.replace(/\\usepackage(\[[^\]]*])?\{[^}]+\}[\r\n]*/g, "");
  html = html.replace(/\\begin\{document\}[\r\n]*/g, "");
  html = html.replace(/\\end\{document\}[\r\n]*/g, "");
  html = html.replace(/\\normalsize\b/g, "");
  html = html.replace(/\\footnotesize\b/g, "");
  html = html.replace(/\\itemsep\s*-?\d+pt\s*\{\}/g, "");
  html = html.replace(/\\vspace\{-?[\d.]+em\}/g, "");
  html = html.replace(/^\s*%\s.*$/gm, "");
  html = html.replace(/^\s*\\item\s+/gm, "");

  // Handle nested structures first - process from innermost to outermost
  // Replace href before other replacements
  html = html.replace(/\\href\{([^}]+)\}\{([^}]+)\}/g, '<a href="$1">$2</a>');

  // Replace text formatting (can be nested)
  let changed = true;
  while (changed) {
    const before = html;
    html = html.replace(
      /\\textbf\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
      "<strong>$1</strong>",
    );
    html = html.replace(
      /\\textit\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g,
      "<em>$1</em>",
    );
    changed = html !== before;
  }

  // {\bf content} -> <strong>content</strong> (resume.cls style bold; removes braces)
  html = html.replace(/\{\\bf\s*([^}]*)\}/g, "<strong>$1</strong>");

  // Only strip grouping braces after \hfill (e.g. "... \hfill {September 2021 - September 2025}") so dates render without literal {}
  html = html.replace(/\\hfill\s*\{([^{}]*)\}/g, "\\hfill $1");

  // Replace \name{...} (resume.cls style header)
  html = html.replace(/\\name\{([^}]+)\}/g, (_, name) => {
    return `<div class="center"><strong class="resume-name">${name.trim()}</strong></div>`;
  });

  // Replace \address{...} (content may include \href{}{}; match balanced braces)
  html = html.replace(/\\address\{((?:[^{}]|\{[^{}]*\})*)\}/g, (_, content) => {
    const parts = content.split(/\\\\/).map((p: string) => p.trim()).filter(Boolean);
    return `<div class="center address">${parts.map((p: string) => `<p>${p}</p>`).join("")}</div>`;
  });

  // Replace \begin{rSection}{Title}...\end{rSection}
  html = html.replace(
    /\\begin\{rSection\}\{([^}]+)\}([\s\S]*?)\\end\{rSection\}/g,
    (_match, title, content) => {
      return `<h2 class="section-title">${title.trim()}</h2>${content.trim()}`;
    },
  );

  // Replace center environment
  html = html.replace(
    /\\begin\{center\}([\s\S]*?)\\end\{center\}/g,
    (_match, content) => {
      return `<div class="center">${content.trim()}</div>`;
    },
  );

  // Replace itemize environment
  html = html.replace(
    /\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/g,
    (_match, content) => {
      const items = content
        .split(/\\item\s+/)
        .filter((item: string) => item.trim());
      const listItems = items
        .map((item: string) => `<li>${item.trim()}</li>`)
        .join("");
      return `<ul class="resume-list">${listItems}</ul>`;
    },
  );

  // Convert project headings that are emitted as standalone \item lines (outside itemize)
  html = html.replace(
    /^\s*\\item\s+((?:\\textbf\{[^}]+\}|<strong>[^<]+<\/strong>)(?:\s*<a href="[^"]+">[^<]+<\/a>)?)/gm,
    "<p>$1</p>",
  );

  // Replace section
  html = html.replace(
    /\\section\{([^}]+)\}/g,
    '<h2 class="section-title">$1</h2>',
  );

  // Convert "left \hfill right" rows into proper two-column aligned rows (left + right on same line).
  html = html.replace(
    /^([^\n]*?)\s*\\hfill\s*([^\n]+)$/gm,
    '<div class="resume-row"><span>$1</span><span>$2</span></div>',
  );

  // Replace tabular (e.g. skills table: Category & skills \\)
  // Match tabular spec on its own line (common in generated output), then parse rows.
  html = html.replace(
    /\\begin\{tabular\}\{[^\n]*\}\s*([\s\S]*?)\\end\{tabular\}/g,
    (_match, content) => {
      const rows = content
        .split(/\\\\/)
        .map((r: string) => r.trim())
        .filter(Boolean);
      const trs = rows
        .map((row: string) => {
          // Split only on unescaped '&' so '\&' remains part of text.
          const cells = row.split(/(?<!\\)&/).map((c: string) => c.trim());
          if (cells.length > 2) {
            // Keep first separator as column split; merge any extra separators into the value.
            const head = cells[0];
            const tail = cells.slice(1).join(" & ");
            return `<tr><td>${head}</td><td>${tail}</td></tr>`;
          }
          const tds = cells.map((cell: string) => `<td>${cell}</td>`).join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      return `<table class="resume-table">${trs}</table>`;
    },
  );

  // Fallback cleanup in case tabular conversion fails for malformed input.
  html = html.replace(/^\s*\\begin\{tabular\}\{.*$/gm, "");
  html = html.replace(/^\s*\\end\{tabular\}\s*$/gm, "");

  // Replace other commands
  html = html.replace(/\\Large\s*/g, "");
  html = html.replace(/\\\\/g, "<br>");
  html = html.replace(
    /\\vspace\{([^}]+)\}/g,
    '<div style="height: $1"></div>',
  );
  html = html.replace(/\\hfill/g, " ");

  // Replace escaped characters
  html = html.replace(/\\&/g, "&");
  html = html.replace(/\\%/g, "%");
  html = html.replace(/\\#/g, "#");
  html = html.replace(/\\\$/g, "$");
  html = html.replace(/\\\{/g, "{");
  html = html.replace(/\\\}/g, "}");
  // Remove stray \bf (already handled via {\bf ...} above)
  html = html.replace(/\\bf\b/g, "");

  // Clean up extra whitespace
  html = html.replace(/\n{3,}/g, "\n\n");

  // Wrap paragraphs
  const lines = html.split("\n");
  const wrappedLines: string[] = [];
  let currentParagraph = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentParagraph) {
        wrappedLines.push(`<p>${currentParagraph}</p>`);
        currentParagraph = "";
      }
      wrappedLines.push("");
    } else if (trimmed.startsWith("<")) {
      // Already HTML tag
      if (currentParagraph) {
        wrappedLines.push(`<p>${currentParagraph}</p>`);
        currentParagraph = "";
      }
      wrappedLines.push(trimmed);
    } else {
      currentParagraph += (currentParagraph ? " " : "") + trimmed;
    }
  }

  if (currentParagraph) {
    wrappedLines.push(`<p>${currentParagraph}</p>`);
  }

  let result = wrappedLines.join("\n");

  // Drop empty section headings if they have no substantive content after cleanup.
  result = result.replace(
    /<h2 class="section-title">([^<]+)<\/h2>\s*(?=(?:<h2 class="section-title">|$))/g,
    "",
  );

  return result;
}

