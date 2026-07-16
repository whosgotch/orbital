// Detects whether prompt-bar text reads as a question (route to Research) or
// a task description (route to Create). Deliberately conservative: only
// clear question marks, question words, and knowledge-request imperatives
// trigger Research — ambiguous verbs like "check"/"fix"/"перевір" stay Create.

const QUESTION_WORDS = new Set([
  // English
  "what", "why", "how", "where", "when", "which", "who", "whose", "whom",
  "can", "could", "does", "did", "is", "are", "was", "were",
  "should", "would", "will",
  // Ukrainian
  "що", "чому", "як", "де", "коли", "який", "яка", "яке", "які", "якого",
  "якої", "яким", "хто", "кого", "кому", "чи", "скільки", "навіщо", "куди",
  "звідки", "чим",
]);

const KNOWLEDGE_IMPERATIVES = new Set([
  // Ukrainian
  "вивчи", "вивчіть", "досліди", "дослідіть", "поясни", "поясніть",
  "опиши", "опишіть", "розкажи", "розкажіть", "порівняй", "порівняйте",
  "проаналізуй", "проаналізуйте",
  // English
  "explain", "describe", "investigate", "research", "compare",
  "summarize", "summarise", "analyze", "analyse",
]);

export function detectIntent(text: string): "research" | "create" {
  const trimmed = text.trim();
  if (!trimmed) return "create";

  if (trimmed.endsWith("?")) return "research";

  const firstWordMatch = trimmed.match(/[\p{L}\p{N}]+/u);
  if (!firstWordMatch) return "create";
  const firstWord = firstWordMatch[0].toLowerCase();

  if (QUESTION_WORDS.has(firstWord) || KNOWLEDGE_IMPERATIVES.has(firstWord)) {
    return "research";
  }

  return "create";
}
