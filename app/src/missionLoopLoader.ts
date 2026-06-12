import type { MissionLoopState } from "./domain";

const missionLoopFixturePath = "/workerMissionFixture.json";

export async function loadMissionLoopState(): Promise<MissionLoopState> {
  const response = await fetch(missionLoopFixturePath);
  if (!response.ok) {
    throw new Error(`Failed to load mission loop state: ${response.status}`);
  }

  return (await response.json()) as MissionLoopState;
}
