import type { MissionLoopState } from "./domain";
import { workerMissionFixture } from "./workerMissionFixture";

export function loadMissionLoopState(): MissionLoopState {
  return workerMissionFixture;
}
