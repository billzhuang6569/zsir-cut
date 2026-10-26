// biome-ignore-all lint/style/noNonNullAssertion: Indexed entries are guarded by schema or test setup.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  fingerprint,
  type Project,
  parseProject,
  rational,
  relinkMedia,
  validateProjectMedia,
  validateProjectSemantics,
} from "../src/index.js";

const root = new URL("../../../", import.meta.url);
async function load(path = "fixtures/projects/std-25.zcut.json"): Promise<Project> {
  const parsed = parseProject(await readFile(new URL(path, root), "utf8"));
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
  return parsed.project;
}
const seconds = (n: bigint, d = 1n) => rational(n, d);
const mediaTrack = (project: Project, id = "trk_v1") => {
  const track = project.timelines[0]!.tracks.find((entry) => entry.id === id);
  if (!track || track.kind === "subtitle") throw new Error(`Missing media track ${id}`);
  return track;
};
const codes = (project: Project) => validateProjectSemantics(project).map((issue) => issue.code);
function expectOnlyError(project: Project, code: string): void {
  const errors = validateProjectSemantics(project)
    .filter((issue) => issue.severity === "error")
    .map((issue) => issue.code);
  expect(errors).toContain(code);
  expect(new Set(errors)).toEqual(new Set([code]));
}

describe("L1 semantic validation", () => {
  it("accepts all five source projects, with only VFR and smooth warnings on standard projects", async () => {
    for (const name of ["std-25", "std-2997-df", "std-2997-ndf"]) {
      const issues = validateProjectSemantics(await load(`fixtures/projects/${name}.zcut.json`));
      expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
      expect(issues.map((issue) => issue.code)).toEqual(["W_VFR", "W_TIMEMAP_APPROX"]);
    }
    for (const name of ["minimal", "interview"])
      expect(validateProjectSemantics(await load(`examples/${name}.zcut.json`))).toEqual([]);
  });

  it("reports one W_TIMEMAP_APPROX per clip with a smooth segment", async () => {
    const project = await load("examples/minimal.zcut.json");
    const clip = mediaTrack(project).clips[0]!;
    clip.time_map = [
      { at: seconds(0n), source: seconds(4n), interp: "linear" },
      { at: seconds(5n), source: seconds(9n), interp: "smooth" },
      { at: seconds(10n), source: seconds(14n), interp: "smooth" },
    ];
    expect(validateProjectSemantics(project)).toEqual([
      {
        code: "W_TIMEMAP_APPROX",
        severity: "warning",
        message: "Smooth time map uses linear approximation",
        ids: [clip.id],
      },
    ]);
    clip.time_map[1]!.interp = "linear";
    expect(validateProjectSemantics(project)).toEqual([]);
  });

  it("merges parse-stage E_TIME_FORM", async () => {
    const text = (await readFile(new URL("fixtures/projects/std-25.zcut.json", root), "utf8")).replace(
      '"source_start": "40s"',
      '"source_start": "80/2s"',
    );
    const parsed = parseProject(text);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    expect(
      validateProjectSemantics(parsed.project, parsed.issues)
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.code),
    ).toEqual(["E_TIME_FORM"]);
  });

  const cases: [string, (project: Project) => void][] = [
    [
      "E_REF",
      (p) => {
        mediaTrack(p).clips[3]!.media_id = "med_missing";
      },
    ],
    [
      "E_ID_DUP",
      (p) => {
        mediaTrack(p).clips[4]!.id = mediaTrack(p).clips[3]!.id;
      },
    ],
    [
      "E_OVERLAP",
      (p) => {
        mediaTrack(p).clips[4]!.timeline_start = seconds(37n);
      },
    ],
    [
      "E_GRID",
      (p) => {
        mediaTrack(p, "trk_v2").clips.at(-1)!.duration = seconds(401n, 100n);
      },
    ],
    [
      "E_SOURCE_RANGE",
      (p) => {
        mediaTrack(p, "trk_v2").clips[1]!.source_start = seconds(1n);
      },
    ],
    [
      "E_HANDLES",
      (p) => {
        mediaTrack(p).transitions[0]!.duration = seconds(180n);
      },
    ],
    [
      "E_TOKEN_RANGE",
      (p) => {
        p.transcripts[0]!.cues[0]!.first_token = "tok_missing";
      },
    ],
    [
      "E_TIMEMAP",
      (p) => {
        mediaTrack(p).clips[5]!.time_map!.pop();
      },
    ],
  ];
  for (const [code, mutate] of cases)
    it(`reports ${code} without unrelated errors`, async () => {
      const project = structuredClone(await load());
      mutate(project);
      expectOnlyError(project, code);
    });

  it("accepts audio boundaries on either frame or sample grid", async () => {
    const project = await load();
    mediaTrack(project, "trk_a3").clips[0]!.timeline_start = seconds(1n, 48000n);
    expect(codes(project)).not.toContain("E_GRID");
  });
  it("checks time-map at on the video frame grid", async () => {
    const project = await load();
    mediaTrack(project).clips[5]!.time_map!.splice(1, 0, {
      at: seconds(1n, 100n),
      source: seconds(601n, 10n),
      interp: "linear",
    });
    expectOnlyError(project, "E_GRID");
  });
  it("uses time-map source extrema for reverse clips", async () => {
    const project = await load();
    mediaTrack(project).clips[6]!.time_map![1]!.source = seconds(91n);
    expectOnlyError(project, "E_SOURCE_RANGE");
  });
  it("multiplies transition margin by boundary speed", async () => {
    const project = await load();
    const from = mediaTrack(project).clips[1]!;
    from.time_map = [
      { at: seconds(0n), source: seconds(40n), interp: "linear" },
      { at: seconds(12n), source: seconds(64n), interp: "linear" },
    ];
    mediaTrack(project).transitions[0]!.duration = seconds(60n);
    expectOnlyError(project, "E_HANDLES");
  });
  it("requires no margin at a hold boundary", async () => {
    const project = await load();
    const from = mediaTrack(project).clips[1]!;
    from.time_map = [
      { at: seconds(0n), source: seconds(40n), interp: "hold" },
      { at: seconds(12n), source: seconds(40n), interp: "linear" },
    ];
    mediaTrack(project).transitions[0]!.alignment = "start";
    mediaTrack(project).transitions[0]!.duration = seconds(500n);
    expect(codes(project)).not.toContain("E_HANDLES");
  });
  it("checks incoming and reverse boundary margins", async () => {
    const incoming = await load();
    mediaTrack(incoming).clips[2]!.time_map = [
      { at: seconds(0n), source: seconds(80n), interp: "linear" },
      { at: seconds(10n), source: seconds(100n), interp: "linear" },
    ];
    mediaTrack(incoming).transitions[0]!.alignment = "end";
    mediaTrack(incoming).transitions[0]!.duration = seconds(45n);
    expectOnlyError(incoming, "E_HANDLES");
    const reverse = await load();
    mediaTrack(reverse).clips[1]!.time_map = [
      { at: seconds(0n), source: seconds(40n), interp: "linear" },
      { at: seconds(12n), source: seconds(20n), interp: "linear" },
    ];
    mediaTrack(reverse).transitions[0]!.alignment = "start";
    mediaTrack(reverse).transitions[0]!.duration = seconds(50n);
    expectOnlyError(reverse, "E_HANDLES");
  });
  it("compares mapped sync only in the overlap", async () => {
    const project = await load();
    const audio = mediaTrack(project, "trk_a2").clips[0]!;
    audio.timeline_start = seconds(44n);
    audio.duration = seconds(4n);
    audio.source_start = seconds(64n);
    audio.time_map = [
      { at: seconds(0n), source: seconds(64n), interp: "linear" },
      { at: seconds(4n), source: seconds(72n), interp: "linear" },
    ];
    expect(codes(project)).not.toContain("W_SYNC");
    audio.time_map[1]!.source = seconds(71n);
    expect(codes(project)).toContain("W_SYNC");
  });
  it("reports W_SYNC, W_TOKEN_TIME and W_LOW_CONF", async () => {
    const project = await load();
    mediaTrack(project, "trk_a1").clips[0]!.source_start = seconds(279n, 25n);
    project.transcripts[0]!.tokens[0]!.align.end = project.transcripts[0]!.tokens[0]!.align.start;
    project.transcripts[0]!.tokens[1]!.align.conf = 0.59;
    for (const code of ["W_SYNC", "W_TOKEN_TIME", "W_LOW_CONF"]) expect(codes(project)).toContain(code);
    expect(validateProjectSemantics(project).filter((issue) => issue.severity === "error")).toEqual([]);
    mediaTrack(project, "trk_a1").clips[0]!.sync_broken = true;
    expect(codes(project)).not.toContain("W_SYNC");
  });
});

describe("L2 media and relink", () => {
  it("finds moved content, ignores same-name wrong content, and reports duplicate copies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcut-relink-"));
    try {
      const project = await load("examples/minimal.zcut.json");
      const media = project.media[0]!;
      const old = join(dir, "old.mov");
      await writeFile(old, "correct media");
      media.path = "old.mov";
      media.size_bytes = 13;
      media.fingerprint = await fingerprint(old);
      await mkdir(join(dir, "drive-a"));
      await mkdir(join(dir, "drive-b"));
      await writeFile(join(dir, "drive-a", "old.mov"), "wrong content");
      await writeFile(join(dir, "drive-a", "z.mov"), "correct media");
      await writeFile(join(dir, "drive-b", "a.mov"), "correct media");
      await rm(old);
      expect((await validateProjectMedia(project, dir)).map((issue) => issue.code)).toEqual(["E_MEDIA_MISSING"]);
      const result = await relinkMedia(project, dir, [join(dir, "drive-b"), join(dir, "drive-a")]);
      expect(result.relinked).toEqual([
        {
          media_id: media.id,
          old_path: "old.mov",
          new_path: "drive-a/z.mov",
          other_candidates: ["drive-b/a.mov"],
        },
      ]);
      expect(project.media[0]!.path).toBe("old.mov");
      expect(await validateProjectMedia(result.project, dir)).toEqual([]);
      expect((await relinkMedia(result.project, dir, [dir])).skipped).toEqual([{ media_id: media.id }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports mismatched media and proxy, then not_found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcut-media-"));
    try {
      const project = await load("examples/minimal.zcut.json");
      const media = project.media[0]!;
      media.path = "same.mov";
      media.size_bytes = 4;
      media.fingerprint = { algo: "sampled-sha256-v1", value: "0".repeat(64) };
      media.proxy = { path: "missing-proxy.mov", fingerprint: media.fingerprint };
      await writeFile(join(dir, "same.mov"), "nope");
      expect((await validateProjectMedia(project, dir)).map((issue) => issue.code)).toEqual([
        "E_MEDIA_MISMATCH",
        "W_PROXY_MISSING",
      ]);
      expect((await relinkMedia(project, dir, [dir])).not_found).toEqual([{ media_id: media.id }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
