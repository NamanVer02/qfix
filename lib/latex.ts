export const RESUME_HTML_STYLES = `
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
`;

export function latexToHtml(latexCode: string): string {
  // Convert LaTeX commands to HTML
  let html = latexCode;

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

  // Replace section
  html = html.replace(
    /\\section\{([^}]+)\}/g,
    '<h2 class="section-title">$1</h2>',
  );

  // Replace tabular (e.g. skills table: Category & skills \\)
  html = html.replace(
    /\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/g,
    (_match, content) => {
      const rows = content
        .split(/\\\\/)
        .map((r: string) => r.trim())
        .filter(Boolean);
      const trs = rows
        .map((row: string) => {
          const cells = row.split(/&/).map((c: string) => c.trim());
          const tds = cells.map((cell: string) => `<td>${cell}</td>`).join("");
          return `<tr>${tds}</tr>`;
        })
        .join("");
      return `<table class="resume-table">${trs}</table>`;
    },
  );

  // Replace other commands
  html = html.replace(/\\Large\s*/g, "");
  html = html.replace(/\\\\/g, "<br>");
  html = html.replace(
    /\\vspace\{([^}]+)\}/g,
    '<div style="height: $1"></div>',
  );
  html = html.replace(
    /\\hfill/g,
    '<span style="float: right;"></span>',
  );

  // Replace escaped characters
  html = html.replace(/\\&/g, "&");
  html = html.replace(/\\%/g, "%");
  html = html.replace(/\\#/g, "#");
  html = html.replace(/\\\$/g, "$");
  html = html.replace(/\\\{/g, "{");
  html = html.replace(/\\\}/g, "}");

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

  return wrappedLines.join("\n");
}

