import type { MissionLoopState } from "./domain";
import workerMissionFixture from "./workerMissionFixture.json";

export function loadMissionLoopState(): MissionLoopState {
  return workerMissionFixture as MissionLoopState;
}
