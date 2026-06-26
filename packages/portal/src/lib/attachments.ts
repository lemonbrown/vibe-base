import workerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { ChatAttachment } from "@vibe/shared";

export type AttachmentDraft = ChatAttachment & {
  status: "ready" | "error";
  error?: string;
};

const MAX_ATTACHMENTS = 5;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_PDF_CHARS = 120_000;

function id(): string {
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
    reader.readAsDataURL(file);
  });
}

async function extractPdfText(file: File): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const bytes = await file.arrayBuffer();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) parts.push(`Page ${i}:\n${text}`);
    if (parts.join("\n\n").length >= MAX_PDF_CHARS) break;
  }
  const text = parts.join("\n\n").slice(0, MAX_PDF_CHARS);
  return { text, pages: doc.numPages };
}

async function processFile(file: File): Promise<AttachmentDraft> {
  if (file.type.startsWith("image/")) {
    if (file.size > MAX_IMAGE_BYTES) {
      return {
        id: id(),
        kind: "image",
        name: file.name || "pasted-image",
        mimeType: file.type,
        size: file.size,
        status: "error",
        error: "Image is larger than 4 MB.",
      };
    }
    try {
      return {
        id: id(),
        kind: "image",
        name: file.name || "pasted-image",
        mimeType: file.type,
        size: file.size,
        dataUrl: await readDataUrl(file),
        status: "ready",
      };
    } catch {
      return {
        id: id(),
        kind: "image",
        name: file.name || "pasted-image",
        mimeType: file.type,
        size: file.size,
        status: "error",
        error: "Could not read image.",
      };
    }
  }

  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
    if (file.size > MAX_PDF_BYTES) {
      return {
        id: id(),
        kind: "pdf",
        name: file.name || "document.pdf",
        mimeType: "application/pdf",
        size: file.size,
        status: "error",
        error: "PDF is larger than 15 MB.",
      };
    }
    try {
      const { text, pages } = await extractPdfText(file);
      return {
        id: id(),
        kind: "pdf",
        name: file.name || "document.pdf",
        mimeType: "application/pdf",
        size: file.size,
        text: text || "(No extractable text found in this PDF.)",
        pages,
        status: "ready",
      };
    } catch {
      return {
        id: id(),
        kind: "pdf",
        name: file.name || "document.pdf",
        mimeType: "application/pdf",
        size: file.size,
        status: "error",
        error: "Could not extract text from PDF.",
      };
    }
  }

  return {
    id: id(),
    kind: "pdf",
    name: file.name || "attachment",
    mimeType: file.type || "application/octet-stream",
    size: file.size,
    status: "error",
    error: "Only images and PDFs are supported.",
  };
}

export async function processFiles(files: File[], existingCount = 0): Promise<AttachmentDraft[]> {
  const remaining = Math.max(0, MAX_ATTACHMENTS - existingCount);
  const selected = files.slice(0, remaining);
  return Promise.all(selected.map(processFile));
}

export function attachmentSummary(att: ChatAttachment): string {
  if (att.kind === "pdf") {
    const pages = att.pages ? `, ${att.pages} page${att.pages === 1 ? "" : "s"}` : "";
    return `${att.name} (PDF${pages})`;
  }
  return `${att.name} (${att.mimeType || "image"})`;
}
