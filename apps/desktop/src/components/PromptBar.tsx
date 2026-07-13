// The universal intake: a chat-style prompt bar floating at the bottom of the
// canvas. Enter creates a task instantly (one per line — a whole backlog at
// once); Plan hands the goal to the AI, which reads the repo and drops a plan
// node plus the tasks it fans out to. While a plan is in flight the bar shows
// the AI's streamed thinking.
import { useRef, useState } from "react";
import { CornerDownLeft, Loader, Sparkles } from "lucide-react";
import { PlanLiveFeed } from "./PlanLiveFeed";
import type { PlanFeedItem } from "../domain";

type PromptBarProps = {
  // Name of the repository new work lands in; undefined disables the bar.
  repoName?: string;
  planning: boolean;
  planFeed: PlanFeedItem[];
  onCreate: (text: string) => void;
  onPlan: (text: string) => void;
};

export function PromptBar({ repoName, planning, planFeed, onCreate, onPlan }: PromptBarProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const trimmed = text.trim();
  const ready = Boolean(trimmed) && Boolean(repoName) && !planning;

  const submit = (action: (value: string) => void) => {
    if (!ready) return;
    action(trimmed);
    setText("");
    inputRef.current?.focus();
  };

  return (
    <div className="prompt-bar" aria-label="New work">
      {planning ? <PlanLiveFeed feed={planFeed} /> : null}
      <textarea
        ref={inputRef}
        className="prompt-bar-input"
        aria-label="Describe a task"
        placeholder={repoName ? "Describe a task — Enter creates, Plan lets the AI break it down" : "Open a repository to start"}
        value={text}
        rows={Math.min(6, Math.max(1, text.split("\n").length))}
        disabled={!repoName || planning}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit(onCreate);
          }
        }}
      />
      <div className="prompt-bar-actions">
        {repoName ? <span className="prompt-bar-target">{repoName}</span> : null}
        <button
          type="button"
          className="secondary mini"
          disabled={!ready}
          onClick={() => submit(onPlan)}
          title="Let the AI read the repo and plan this goal into tasks"
        >
          {planning ? <Loader size={13} className="spin" aria-hidden="true" /> : <Sparkles size={13} aria-hidden="true" />}
          <span>Plan</span>
        </button>
        <button
          type="button"
          className="primary mini"
          disabled={!ready}
          onClick={() => submit(onCreate)}
          title="Create task — one per line"
        >
          <CornerDownLeft size={13} aria-hidden="true" />
          <span>Create</span>
        </button>
      </div>
    </div>
  );
}
