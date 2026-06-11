import type { Envelope, JobType } from "./domain";

export type Skill = (jobType: JobType, input: {
  jobId: string;
  inlineInputs: Record<string, unknown>;
  inputRefs: { system: string; key: string; url?: string; label?: string }[];
}) => Promise<Envelope>;

/** M0 stub standing in for the real Claude CLI skill. Returns fixed, well-shaped envelopes. */
export const stubSkill: Skill = async (jobType) => {
  switch (jobType) {
    case "generate":
      return {
        domainOutput: { summary: "PRD 초안 요약 (스텁)" },
        refs: [
          { system: "git", key: "prd-repo@abc1234", url: "https://git.example/abc1234" },
          { system: "wiki", key: "10001", url: "https://wiki.example/pages/10001" },
        ],
      };
    case "quality":
      return {
        domainOutput: { score: 90, missing_items: [], summary: "PRD 초안 요약 (스텁)" },
        refs: [],
      };
    case "routing":
      return {
        domainOutput: { next_task_types: ["hld"] },
        refs: [],
        nextTaskCandidates: ["hld"],
      };
  }
};
