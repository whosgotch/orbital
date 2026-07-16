import type { WorkerMode } from "../missionUi";
import type { Repository } from "../domain";

type QueueIntakePanelProps = {
  repositories: Repository[];
  missionDraft: string;
  onChangeMissionDraft: (text: string) => void;
  campaignTargetRepos: () => Repository[];
  onToggleCampaignRepo: (repoId: string) => void;
  intakeWorkerMode: WorkerMode;
  onChangeIntakeWorkerMode: (mode: WorkerMode) => void;
  onQueue: () => void;
};

export function QueueIntakePanel({
  repositories,
  missionDraft,
  onChangeMissionDraft,
  campaignTargetRepos,
  onToggleCampaignRepo,
  intakeWorkerMode,
  onChangeIntakeWorkerMode,
  onQueue,
}: QueueIntakePanelProps) {
  const targets = campaignTargetRepos();

  return (
    <section className="popover mission-popover" aria-label="Queue tasks">
      <div className="section-label">Queue tasks</div>
      <textarea
        aria-label="Tasks to queue"
        placeholder={"One task per line — queue a whole backlog at once.\nadd a healthcheck endpoint\nupgrade the logging library\n…"}
        value={missionDraft}
        onChange={(event) => onChangeMissionDraft(event.target.value)}
      />
      {repositories.length > 1 ? (
        <div className="campaign-targets">
          <div className="section-label">Target repos {targets.length > 1 ? "· campaign" : ""}</div>
          <ul className="campaign-repo-list">
            {repositories.map((repo) => {
              const checked = targets.some((target) => target.id === repo.id);
              return (
                <li key={repo.id}>
                  <label>
                    <input type="checkbox" checked={checked} onChange={() => onToggleCampaignRepo(repo.id)} />
                    <span>{repo.name}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      <label className="intake-worker">
        <span>Worker</span>
        <select
          aria-label="Worker mode"
          value={intakeWorkerMode}
          onChange={(event) => onChangeIntakeWorkerMode(event.target.value as WorkerMode)}
        >
          <option value="claude-engineer">Claude (AI)</option>
          <option value="local-command">Local command</option>
        </select>
      </label>
      <button className="primary command-button" type="button" onClick={onQueue} disabled={!missionDraft.trim()}>
        {targets.length > 1
          ? `Queue in ${targets.length} repos`
          : `Queue ${missionDraft.split("\n").filter((line) => line.trim()).length > 1 ? "backlog" : "task"}`}
      </button>
    </section>
  );
}
