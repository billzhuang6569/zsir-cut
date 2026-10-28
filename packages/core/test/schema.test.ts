import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeCommand,
  validateCommand,
  validateEnvelope,
  validateLossReport,
  validateManifest,
  validateProject,
} from "../src/schema.js";

const root = new URL("../../../", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const interview = read("examples/interview.zcut.json");
const lossReport = read("examples/handoff/loss-report.json");
const manifest = read("examples/handoff/manifest.json");

describe("request rational normalization", () => {
  it("reduces frame rates before enum validation without changing other strings", () => {
    const input = {
      project: "50/25s.zcut.json",
      name: "50/25s",
      timeline: { name: "50/25s", edit_rate: "60000/2002" },
      idempotency_key: "rate",
      author: { kind: "agent", name: "50/25s" },
    };
    const normalized = normalizeCommand("create_project", input);
    expect(normalized).toEqual({ ...input, timeline: { ...input.timeline, edit_rate: "30000/1001" } });
    expect(input.timeline.edit_rate).toBe("60000/2002");
    expect(validateCommand("create_project", normalized).valid).toBe(true);
  });

  it("normalizes read ranges and transcription rules while leaving malformed times invalid", () => {
    expect(normalizeCommand("read_transcript", { range: { start: "0/25s", duration: "50/25s" } })).toEqual({
      range: { start: "0s", duration: "2s" },
    });
    expect(normalizeCommand("transcribe", { rules: { min_duration: "50/25s", soft_pause: "20/50s" } })).toEqual({
      rules: { min_duration: "2s", soft_pause: "2/5s" },
    });
    for (const duration of ["1/0s", "-1s", "1.5s", "01s"])
      expect(normalizeCommand("inspect", { range: { start: "0s", duration } })).toEqual({
        range: { start: "0s", duration },
      });
  });
});

describe("schema examples", () => {
  for (const directory of ["examples", "fixtures/projects"]) {
    for (const name of readdirSync(new URL(directory, root)).filter((name) => name.endsWith(".zcut.json"))) {
      it(`${directory}/${name}`, () => {
        expect(validateProject(read(`${directory}/${name}`))).toEqual({ valid: true, errors: [] });
      });
    }
  }

  it("loss report", () => {
    expect(validateLossReport(lossReport)).toEqual({ valid: true, errors: [] });
  });

  it("manifest with relative loss-report reference", () => {
    expect(validateManifest(manifest)).toEqual({ valid: true, errors: [] });
  });
});

const projectCases: Array<[string, (document: typeof interview) => void]> = [
  [
    "decimal duration",
    (document) => {
      document.timelines[0].tracks[0].clips[0].duration = "5.005s";
    },
  ],
  [
    "zero duration",
    (document) => {
      document.timelines[0].tracks[0].clips[0].duration = "0s";
    },
  ],
  [
    "wrong clip prefix",
    (document) => {
      document.timelines[0].tracks[0].clips[0].id = "clip_1";
    },
  ],
  [
    "drop-frame at 25 fps",
    (document) => {
      document.timelines[0].edit_rate = "25";
    },
  ],
  [
    "missing video",
    (document) => {
      delete document.media[0].video;
    },
  ],
  [
    "unknown clip field",
    (document) => {
      document.timelines[0].tracks[0].clips[0].start = 0;
    },
  ],
  [
    "missing carrier tracks",
    (document) => {
      delete document.timelines[0].tracks[3].carrier_tracks;
    },
  ],
  [
    "absolute media path",
    (document) => {
      document.media[0].path = "/Volumes/x.mov";
    },
  ],
  [
    "invalid extension namespace",
    (document) => {
      document.ext = { FCPXML: {} };
    },
  ],
  [
    "wrong schema version",
    (document) => {
      document.schema_version = "1.0";
    },
  ],
  [
    "legacy speed field",
    (document) => {
      document.timelines[0].tracks[0].clips[0].speed = "2";
    },
  ],
  [
    "one time-map point",
    (document) => {
      document.timelines[0].tracks[1].clips[0].time_map = [{ at: "0s", source: "0s", interp: "linear" }];
    },
  ],
  [
    "unknown interpolation",
    (document) => {
      document.timelines[0].tracks[1].clips[0].time_map[0].interp = "bezier";
    },
  ],
  [
    "missing time-map source",
    (document) => {
      delete document.timelines[0].tracks[1].clips[0].time_map[0].source;
    },
  ],
];

describe("invalid projects", () => {
  it.each(projectCases)("%s", (_name, mutate) => {
    const document = structuredClone(interview);
    mutate(document);
    expect(validateProject(document).valid).toBe(false);
  });
});

const lossCases: Array<[string, (document: typeof lossReport) => void]> = [
  [
    "preserved entry",
    (document) => {
      document.items[0].status = "preserved";
    },
  ],
  [
    "baked without asset",
    (document) => {
      document.items[0].status = "baked";
    },
  ],
  [
    "unknown reason",
    (document) => {
      document.items[0].reason_code = "R_WHATEVER";
    },
  ],
  [
    "unknown profile",
    (document) => {
      document.profile = "fcp-12-fcpxml-1.14";
    },
  ],
];

describe("invalid loss reports", () => {
  it.each(lossCases)("%s", (_name, mutate) => {
    const document = structuredClone(lossReport);
    mutate(document);
    expect(validateLossReport(document).valid).toBe(false);
  });
});

const manifestCases: Array<[string, (document: typeof manifest) => void]> = [
  [
    "unknown host",
    (document) => {
      document.profile.host = "avid";
    },
  ],
  [
    "unknown import status",
    (document) => {
      document.validation.host_import.status = "ok";
    },
  ],
  [
    "missing render comparison",
    (document) => {
      delete document.validation.host_render_comparison;
    },
  ],
];

describe("invalid manifests", () => {
  it.each(manifestCases)("%s", (_name, mutate) => {
    const document = structuredClone(manifest);
    mutate(document);
    expect(validateManifest(document).valid).toBe(false);
  });
});

const appliedEnvelope = {
  ok: true,
  status: "applied",
  verb: "edit",
  request_id: "req_0192a7f3",
  receipt: {
    before: "rev_41",
    after: "rev_42",
    idempotency_key: "agent-run-7-step-3",
    replayed: false,
  },
  changes: [
    { op: "remove_span", entity: "clip", id: "clp_v_2", action: "trimmed" },
    { op: "remove_span", entity: "clip", id: "clp_v_2b", action: "created" },
  ],
  verification: {
    level: "L1",
    passed: true,
    issues: [{ code: "W_SUB_UNPROJECTED", severity: "warning", message: "...", ids: ["cue_3"] }],
  },
  result: {},
  error: null,
};

describe("envelope", () => {
  it("accepts the applied example from command protocol section 4", () => {
    expect(validateEnvelope(appliedEnvelope)).toEqual({ valid: true, errors: [] });
  });

  it("rejects rejected status with ok true", () => {
    const envelope = {
      ...appliedEnvelope,
      status: "rejected",
      error: { code: "E_VALIDATION", message: "invalid", retryable: false },
    };
    expect(validateEnvelope(envelope).valid).toBe(false);
  });
});
