// Pasted images: the input-parity piece of the prompt bar and node chats.
// A pasted screenshot is saved under <repo>/.orbital/attachments and travels
// as a file path inside the mission/chat text — the agent opens the file from
// disk to look at it.
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export async function saveAttachment(repoPath: string, file: Blob, extension: string): Promise<string> {
  return invoke<string>("save_attachment", { repoPath, extension, data: await toBase64(file) });
}

const ATTACHMENT_LINE_PREFIX = "Attached image — open and view it: ";

// The lines appended to a prompt so the agent knows to open the images.
export function attachmentLines(paths: string[]): string {
  if (paths.length === 0) return "";
  return "\n\n" + paths.map((path) => `${ATTACHMENT_LINE_PREFIX}${path}`).join("\n");
}

// Display text for a mission: the prompt without its attachment lines — the
// paths are agent plumbing, not something a node card should wear.
export function stripAttachmentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith(ATTACHMENT_LINE_PREFIX))
    .join("\n")
    .trim();
}

export function attachmentCount(text: string): number {
  return text.split("\n").filter((line) => line.trim().startsWith(ATTACHMENT_LINE_PREFIX)).length;
}

export function attachmentName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function imageExtension(mimeType: string): string {
  const ext = mimeType.split("/")[1] ?? "png";
  return ext === "jpeg" ? "jpg" : ext;
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL yields "data:<mime>;base64,<data>" — keep only the data.
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// usePastedImages wires a composer's onPaste: images land on disk immediately
// and show as removable chips; the submit handler collects paths and clears.
export function usePastedImages(repoPath?: string) {
  const [paths, setPaths] = useState<string[]>([]);

  const onPaste = (event: React.ClipboardEvent) => {
    if (!repoPath) return;
    const images = Array.from(event.clipboardData.items).filter((item) => item.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    for (const item of images) {
      const file = item.getAsFile();
      if (!file) continue;
      void saveAttachment(repoPath, file, imageExtension(item.type))
        .then((path) => setPaths((current) => [...current, path]))
        .catch((error) => console.error("[orbital] attachment save failed", error));
    }
  };

  const remove = (path: string) => setPaths((current) => current.filter((item) => item !== path));
  const clear = () => setPaths([]);

  return { paths, onPaste, remove, clear };
}
