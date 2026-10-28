import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  add,
  compareCuttingLists,
  cuttingList,
  div,
  fingerprint,
  floor,
  parseProject,
  rational,
  runExport,
  serializeProject,
  sub,
} from "../../core/src/index.js";
import exporter from "../src/index.js";

const profile = "premiere-25-xmeml-5";
const fixtures = ["std-25", "std-2997-df", "std-2997-ndf", "std-2398", "std-5994-df"];
const mediaRoot = pathToFileURL(resolve("fixtures/.media")).href.replace("file:///", "file://localhost/");
const previewStub: NonNullable<Parameters<typeof runExport>[6]> = async (_project, _timeline, _path, options) => {
  const data = Buffer.from("preview test placeholder");
  await writeFile(options.output, data);
  return { path: options.output, sha256: createHash("sha256").update(data).digest("hex"), frames: "0" };
};
const clipitem = (xml: string, id: string) => {
  const item = xml.match(new RegExp(`<clipitem id="${id}">[\\s\\S]*?</clipitem>`))?.[0];
  if (!item) throw new Error(`Missing clipitem ${id}`);
  return item;
};
const parameterValue = (xml: string, id: string) => {
  const raw = xml.match(
    new RegExp(`<parameterid>${id}</parameterid>\\s*<name>[^<]*</name>\\s*<value>([^<]+)</value>`),
  )?.[1];
  if (raw === undefined) throw new Error(`Missing parameter ${id}`);
  return raw;
};
const frame = (xml: string, tag: string) => {
  const raw = xml.match(new RegExp(`<${tag}>(\\d+)</${tag}>`))?.[1];
  if (raw === undefined) throw new Error(`Missing frame ${tag}`);
  return Number(raw);
};
const graphKeys = (xml: string) =>
  [...xml.matchAll(/<keyframe>([\s\S]*?)<\/keyframe>/g)].map((match) => ({
    when: frame(match[1] ?? "", "when"),
    value: frame(match[1] ?? "", "value"),
  }));
const changeParameter = (xml: string, id: string, value: string) =>
  xml.replace(
    new RegExp(`(<parameterid>${id}</parameterid>\\s*<name>[^<]*</name>\\s*<value>)[^<]+`),
    (_match, prefix: string) => `${prefix}${value}`,
  );

async function generate(path: string) {
  const parsed = parseProject(await readFile(path, "utf8"));
  if (!parsed.ok) throw new Error(`Invalid fixture ${path}`);
  const project = parsed.project;
  const timeline = project.timelines[0];
  if (!timeline) throw new Error("Missing timeline");
  const paths = new Map(project.media.map((media) => [media.id, resolve(dirname(path), media.path)]));
  const xml = (await exporter.generate(project, timeline, profile, paths)).data.toString();
  return { project, timeline, paths, xml };
}

describe("Premiere xmeml v5", () => {
  it.each(["fixtures/projects/std-2398.zcut.json", "fixtures/regressions/xmeml-reverse-grid.zcut.json"])(
    "%s reports the reverse source-frame displacement using the exact file length",
    async (path) => {
      const { project, timeline, xml } = await generate(path);
      const item = clipitem(xml, "clp_v7");
      expect(parameterValue(item, "reverse")).toBe("TRUE");
      expect(parameterValue(item, "speed")).toBe("100");
      const file = xml.match(/<file id="med_B">[\s\S]*?<\/file>/)?.[0];
      if (!file) throw new Error("Missing source file");
      expect(frame(file, "duration")).toBe(2698);
      // Native source/sequence rate ratio is 5/4; keep file length exact until the final source-frame rounding.
      const source = (coordinate: number) =>
        Number(floor(add(sub(rational(2698n), rational(BigInt(coordinate) * 5n, 4n)), rational(1n, 2n))));
      expect([source(frame(item, "in")), source(frame(item, "out"))]).toEqual([1101, 1001]);
      expect((await exporter.readBack(xml, timeline)).find((row) => row.clip_id === "clp_v7")).toMatchObject({
        source_in: 1101,
        source_out: 1001,
      });
      expect(exporter.losses(project, timeline, profile)).toContainEqual(
        expect.objectContaining({
          entity_id: "clp_v7",
          feature: "clip_cut",
          status: "approximated",
          severity: "warning",
          reason_code: "R_GRID_ROUNDED",
          consequence: expect.stringContaining("源入点偏差 1 源帧、源出点偏差 1 源帧"),
        }),
      );
    },
  );
  it.each(["reverse", "slow"])(
    "preserves exactly representable mixed-rate %s cuts without a rounding loss",
    async (kind) => {
      const { project, timeline, paths } = await generate("fixtures/regressions/xmeml-reverse-grid.zcut.json");
      const track = timeline.tracks[0];
      if (track?.kind !== "video" || !track.clips[0]) throw new Error("Missing clip");
      const clip = track.clips[0];
      clip.source_start =
        kind === "reverse" ? rational(1098n * 1001n, 30000n) : div(rational(1n, 2n), timeline.edit_rate);
      clip.time_map = [
        { at: rational(0n), source: clip.source_start, interp: "linear" },
        {
          at: clip.duration,
          source: add(
            clip.source_start,
            kind === "reverse" ? rational(-100n * 1001n, 30000n) : div(clip.duration, rational(2n)),
          ),
          interp: "linear",
        },
      ];
      const xml = (await exporter.generate(project, timeline, profile, paths)).data.toString();
      expect(frame(clipitem(xml, clip.id), "in")).toBe(kind === "reverse" ? 1280 : 1);
      expect((await exporter.readBack(xml, timeline)).find((row) => row.clip_id === clip.id)).toMatchObject(
        kind === "reverse" ? { source_in: 1098, source_out: 998 } : { source_in: 1, source_out: 51 },
      );
      expect(
        exporter.losses(project, timeline, profile).filter((item) => item.reason_code === "R_GRID_ROUNDED"),
      ).toEqual([]);
      expect(await exporter.validate(xml)).toBe(true);
    },
  );
  it("keeps a hold fixed even when the following source point jumps", async () => {
    const { project, timeline, paths } = await generate("fixtures/regressions/xmeml-retime.zcut.json");
    const track = timeline.tracks[0];
    const hold = track?.kind === "video" ? track.clips.find((clip) => clip.id === "clp_hold") : undefined;
    const last = hold?.time_map?.at(-1);
    if (!last) throw new Error("Missing hold endpoint");
    last.source = { numerator: 5n, denominator: 1n };
    const xml = (await exporter.generate(project, timeline, profile, paths)).data.toString();
    expect(graphKeys(clipitem(xml, "clp_hold"))).toEqual([
      { when: 0, value: 249 },
      { when: 25, value: 249 },
    ]);
    expect(await exporter.readBack(xml, timeline)).toEqual(cuttingList(project, timeline, profile));
    expect(await exporter.validate(xml)).toBe(true);
  });
  for (const name of fixtures) {
    it(`${name} round trips every cut and matches golden`, async () => {
      const path = `fixtures/projects/${name}.zcut.json`;
      const { project, timeline, paths, xml } = await generate(path);
      const expected = cuttingList(project, timeline, profile);
      expect(await exporter.readBack(xml, timeline)).toEqual(expected);
      expect(compareCuttingLists(expected, await exporter.readBack(xml, timeline)).zero_frame_deviation).toBe(true);
      expect(await exporter.validate(xml)).toBe(true);
      expect((await exporter.generate(project, timeline, profile, paths)).data).toBe(xml);
      expect(xml.replaceAll(mediaRoot, "file://localhost/__MEDIA_ROOT__")).toBe(
        await readFile(`fixtures/golden/xmeml/${name}.xml`, "utf8"),
      );
    });
  }
  for (const name of ["std-25", "std-2997-df", "std-2997-ndf"]) {
    it(`${name} writes retimed in/out and constant graphdict freeze frames`, async () => {
      const { xml } = await generate(`fixtures/projects/${name}.zcut.json`);
      const is25 = name === "std-25";
      for (const [id, input, output] of [
        ["clp_v6", 750, 950],
        ["clp_v7", is25 ? 1150 : 1598, is25 ? 1250 : 1698],
        ["clp_v8-s1", is25 ? 4790 : 5754, is25 ? 4840 : 5804],
        ["clp_v8-s2", 0, 25],
      ] as const) {
        const item = clipitem(xml, id);
        expect(frame(item, "in")).toBe(input);
        expect(frame(item, "out")).toBe(output);
      }
      for (const match of xml.matchAll(/<clipitem\b[^>]*>[\s\S]*?<\/clipitem>/g)) {
        const item = match[0];
        expect(frame(item, "out") - frame(item, "in")).toBe(frame(item, "end") - frame(item, "start"));
      }
      const hold = clipitem(xml, "clp_v8-s2");
      expect(parameterValue(hold, "variablespeed")).toBe("1");
      expect(hold).toMatch(/<parameter>\s*<parameterid>graphdict<\/parameterid>[\s\S]*?<keyframe>/);
      expect(graphKeys(hold)).toEqual([
        { when: 0, value: is25 ? 2420 : 2902 },
        { when: 25, value: is25 ? 2420 : 2902 },
      ]);
      expect(xml).not.toContain("<parameterid>freeze</parameterid>");
    });
  }
  for (const path of [
    "fixtures/regressions/parent-25-on-2997.zcut.json",
    "fixtures/regressions/otio-2997-fcpxml-grid.zcut.json",
    "fixtures/regressions/xmeml-sequence-grid.zcut.json",
    "fixtures/regressions/xmeml-retime.zcut.json",
    "examples/minimal.zcut.json",
    "examples/interview.zcut.json",
  ]) {
    it(`${path} reads back at zero frames`, async () => {
      const { project, timeline, xml } = await generate(path);
      expect(
        compareCuttingLists(cuttingList(project, timeline, profile), await exporter.readBack(xml, timeline))
          .zero_frame_deviation,
      ).toBe(true);
      expect(await exporter.validate(xml)).toBe(true);
    });
  }
  it("writes native file rates, links, filters, marker, transition, and fixed losses", async () => {
    const { project, timeline, xml } = await generate("fixtures/projects/std-25.zcut.json");
    expect(xml).toContain('<xmeml version="5">');
    expect(xml).toContain("<pathurl>file://localhost/");
    expect(xml).toContain("<linkclipref>clp_a1</linkclipref>");
    expect(xml).toContain("<effectid>Cross Dissolve</effectid>");
    expect(xml).toContain("<effectid>timeremap</effectid>");
    expect(xml).toContain("<effectid>audiolevels</effectid>");
    expect(xml).toContain("<effectid>basic</effectid>");
    expect(xml).toContain("<effectid>crop</effectid>");
    expect(clipitem(xml, "clp_vfr")).toMatch(/<in>0<\/in>\s*<out>100<\/out>/);
    expect(clipitem(xml, "clp_ext")).toMatch(/<in>328<\/in>\s*<out>568<\/out>/);
    for (const [id, speed, reverse, variable] of [
      ["clp_v6", "200", "FALSE", "0"],
      ["clp_v7", "100", "TRUE", "0"],
      ["clp_v8-s2", "0", "FALSE", "1"],
    ]) {
      const item = clipitem(xml, id);
      expect(parameterValue(item, "speed")).toBe(speed);
      expect(parameterValue(item, "reverse")).toBe(reverse);
      expect(parameterValue(item, "variablespeed")).toBe(variable);
    }
    expect(xml).toContain("<marker id=");
    expect(xml).toContain("segment=3");
    const losses = exporter.losses(project, timeline, profile);
    expect(losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ feature: "subtitle_text_timing", reason_code: "R_SUB_MANUAL_IMPORT" }),
        expect.objectContaining({ feature: "subtitle_style", reason_code: "R_STYLE_NOT_REPRESENTABLE" }),
        expect.objectContaining({ feature: "speed_segmented", reason_code: "R_SPLIT_FOR_RETIME" }),
        expect.objectContaining({ feature: "speed_smooth", reason_code: "R_SPLIT_FOR_RETIME" }),
      ]),
    );
    expect(losses.some((item) => item.feature === "gain" || item.feature === "transform")).toBe(false);
  });
  it("rounds video and audio source cuts on the sequence grid, with half frames upward", async () => {
    const { project, timeline, xml } = await generate("fixtures/regressions/xmeml-sequence-grid.zcut.json");
    for (const id of ["clp_vfr", "clp_ext"]) {
      const item = clipitem(xml, id);
      expect(item).toMatch(/<rate>\s*<timebase>25<\/timebase>\s*<ntsc>FALSE<\/ntsc>\s*<\/rate>/);
      expect(item).toMatch(/<in>1<\/in>\s*<out>26<\/out>/);
    }
    expect(clipitem(xml, "clp_vfr")).toMatch(/<file id="med_VFR">[\s\S]*?<timebase>30<\/timebase>/);
    expect(clipitem(xml, "clp_ext")).toMatch(/<file id="med_EXT">[\s\S]*?<timebase>48000<\/timebase>/);
    const losses = exporter.losses(project, timeline, profile).filter((item) => item.reason_code === "R_GRID_ROUNDED");
    expect(losses).toHaveLength(2);
    for (const id of ["clp_vfr", "clp_ext"])
      expect(losses).toContainEqual(
        expect.objectContaining({
          entity_id: id,
          feature: "clip_cut",
          status: "approximated",
          severity: "warning",
        }),
      );
    const rows = await exporter.readBack(xml, timeline);
    expect(rows.find((row) => row.clip_id === "clp_ext")).toMatchObject({ source_in: 1920, source_out: 49920 });
  });
  it("rounds the retimed coordinate and preserves reverse, slow tail, and last-frame freeze ranges", async () => {
    const { project, timeline, xml } = await generate("fixtures/regressions/xmeml-retime.zcut.json");
    const rows = await exporter.readBack(xml, timeline);
    for (const [id, input, output, sourceIn, sourceOut, speed] of [
      ["clp_fast", 1, 26, 2, 52, "2"],
      ["clp_reverse", 25, 50, 200, 150, "-2"],
      ["clp_slow", 450, 500, 225, 250, "1/2"],
      ["clp_hold", 0, 25, 249, 249, "0"],
    ] as const) {
      const item = clipitem(xml, id);
      expect(frame(item, "in")).toBe(input);
      expect(frame(item, "out")).toBe(output);
      expect(rows.find((row) => row.clip_id === id)).toMatchObject({
        source_in: sourceIn,
        source_out: sourceOut,
        speed,
      });
    }
    expect(rows).toEqual(cuttingList(project, timeline, profile));
    expect(await exporter.validate(xml)).toBe(true);
    expect(exporter.losses(project, timeline, profile).filter((item) => item.reason_code === "R_GRID_ROUNDED")).toEqual(
      [
        expect.objectContaining({
          entity_id: "clp_fast",
          feature: "clip_cut",
          status: "approximated",
          severity: "warning",
          consequence: expect.stringContaining("源入点偏差 1 源帧、源出点偏差 1 源帧"),
        }),
      ],
    );
    expect(graphKeys(clipitem(xml, "clp_hold"))).toEqual([
      { when: 0, value: 249 },
      { when: 25, value: 249 },
    ]);
  });
  it("reads actual speed, reverse, and freeze graph values rather than the logged speed", async () => {
    const { project, timeline, xml } = await generate("fixtures/regressions/xmeml-retime.zcut.json");
    for (const [id, parameter, value, sourceIn, sourceOut, speed] of [
      ["clp_fast", "speed", "100", 1, 26, "1"],
      ["clp_reverse", "reverse", "FALSE", 50, 100, "2"],
    ] as const) {
      const item = clipitem(xml, id);
      const altered = xml.replace(item, changeParameter(item, parameter, value));
      expect(altered).not.toBe(xml);
      const rows = await exporter.readBack(altered, timeline);
      expect(rows.find((row) => row.clip_id === id)).toMatchObject({
        source_in: sourceIn,
        source_out: sourceOut,
        speed,
      });
      expect(compareCuttingLists(cuttingList(project, timeline, profile), rows).zero_frame_deviation).toBe(false);
      expect(await exporter.validate(altered)).toBe(false);
    }
    const hold = clipitem(xml, "clp_hold");
    const altered = xml.replace(hold, hold.replaceAll("<value>249</value>", "<value>248</value>"));
    const rows = await exporter.readBack(altered, timeline);
    expect(rows.find((row) => row.clip_id === "clp_hold")).toMatchObject({ source_in: 248, source_out: 248 });
    expect(compareCuttingLists(cuttingList(project, timeline, profile), rows).zero_frame_deviation).toBe(false);
  });
  it("uses the serialized rational speed when mapping source frames at a rounding boundary", async () => {
    const { project, timeline, paths } = await generate("fixtures/regressions/xmeml-retime.zcut.json");
    const track = timeline.tracks[0];
    if (track?.kind !== "video" || !track.clips[0]) throw new Error("Missing retime regression clip");
    const clip = track.clips[0];
    clip.source_start = rational(1n, 10n);
    clip.duration = rational(6n, 25n);
    clip.time_map = [
      { at: rational(0n), source: rational(1n, 10n), interp: "linear" },
      { at: rational(6n, 25n), source: rational(3n, 10n), interp: "linear" },
    ];
    const xml = (await exporter.generate(project, timeline, profile, paths)).data.toString();
    const item = clipitem(xml, clip.id);
    expect(frame(item, "in")).toBe(3);
    expect(frame(item, "out")).toBe(9);
    expect(parameterValue(item, "speed")).toBe("83.333333333");
    const rows = await exporter.readBack(xml, timeline);
    expect(rows.find((row) => row.clip_id === clip.id)).toMatchObject({ source_in: 2, source_out: 7, speed: "5/6" });
    expect(rows).toEqual(cuttingList(project, timeline, profile));
    expect(await exporter.validate(xml)).toBe(true);
    expect(exporter.losses(project, timeline, profile)).toContainEqual(
      expect.objectContaining({ entity_id: clip.id, feature: "clip_cut", reason_code: "R_GRID_ROUNDED" }),
    );
  });
  it("rejects malformed freeze graphs, invalid speed, and mapped source overflow", async () => {
    const { xml } = await generate("fixtures/regressions/xmeml-retime.zcut.json");
    const hold = clipitem(xml, "clp_hold");
    for (const alteredHold of [
      hold.replace(/<keyframe>[\s\S]*?<\/keyframe>/, ""),
      hold.replace("<when>25</when>", "<when>24</when>"),
      hold.replace("<value>249</value>", "<value>248</value>"),
      hold.replaceAll("<value>249</value>", "<value>250</value>"),
      changeParameter(hold, "variablespeed", "0"),
    ]) {
      expect(alteredHold).not.toBe(hold);
      expect(await exporter.validate(xml.replace(hold, alteredHold))).toBe(false);
    }
    const fast = clipitem(xml, "clp_fast");
    for (const speed of ["-200", "0", "NaN", "300"])
      expect(await exporter.validate(xml.replace(fast, changeParameter(fast, "speed", speed)))).toBe(false);
    const slow = clipitem(xml, "clp_slow");
    const overflow = slow.replace("<in>450</in>", "<in>452</in>").replace("<out>500</out>", "<out>502</out>");
    expect(await exporter.validate(xml.replace(slow, overflow))).toBe(false);
    expect(await exporter.validate(xml.replace(fast, fast.replace("<out>26</out>", "<out>27</out>")))).toBe(false);
  });
  it("writes a complete self-inclusive occurrence group with actual one-based track and clip indices", async () => {
    const { timeline, xml } = await generate("fixtures/projects/std-25.zcut.json");
    const parts: { id: string; occurrence: string; kind: string; track: number; index: number; item: string }[] = [];
    for (const kind of ["video", "audio"] as const) {
      for (const [trackIndex, track] of timeline.tracks.filter((entry) => entry.kind === kind).entries()) {
        const trackXml = xml.match(new RegExp(`<track id="${track.id}">([\\s\\S]*?)</track>`))?.[1] ?? "";
        for (const [clipIndex, match] of [
          ...trackXml.matchAll(/<clipitem id="([^"]+)">[\s\S]*?<\/clipitem>/g),
        ].entries()) {
          parts.push({
            id: match[1] ?? "",
            occurrence: / occ=(\S+)/.exec(match[0])?.[1] ?? "",
            kind,
            track: trackIndex + 1,
            index: clipIndex + 1,
            item: match[0],
          });
        }
      }
    }
    expect(parts.length).toBeGreaterThan(20);
    for (const part of parts) {
      const links = [
        ...part.item.matchAll(
          /<link>\s*<linkclipref>([^<]+)<\/linkclipref>\s*<mediatype>([^<]+)<\/mediatype>\s*<trackindex>(\d+)<\/trackindex>\s*<clipindex>(\d+)<\/clipindex>\s*<\/link>/g,
        ),
      ].map((match) => ({ id: match[1], kind: match[2], track: Number(match[3]), index: Number(match[4]) }));
      const group = parts
        .filter((other) => other.occurrence === part.occurrence)
        .map(({ id, kind, track, index }) => ({ id, kind, track, index }));
      expect(links, part.id).toEqual(group);
    }
  });
  it("rejects missing self links, duplicate links, wrong group members, and wrong indices", async () => {
    const { xml } = await generate("fixtures/projects/std-25.zcut.json");
    const item = clipitem(xml, "clp_v1");
    const own = item.match(/<link>\s*<linkclipref>clp_v1<\/linkclipref>[\s\S]*?<\/link>/)?.[0];
    if (!own) throw new Error("Missing self link");
    for (const alteredItem of [
      item.replace(own, ""),
      item.replace(own, `${own}\n${own}`),
      item.replace(own, own.replace("clp_v1", "clp_v2")),
      item.replace(own, own.replace("<mediatype>video</mediatype>", "<mediatype>audio</mediatype>")),
      item.replace(own, own.replace("<trackindex>1</trackindex>", "<trackindex>2</trackindex>")),
      item.replace(own, own.replace("<clipindex>1</clipindex>", "<clipindex>2</clipindex>")),
    ]) {
      expect(alteredItem).not.toBe(item);
      expect(await exporter.validate(xml.replace(item, alteredItem))).toBe(false);
    }
  });
  it("converts motion and crop ratios into FCP7 units and keeps audio level linear", async () => {
    const { xml } = await generate("fixtures/regressions/xmeml-sequence-grid.zcut.json");
    const motion = clipitem(xml, "clp_vfr");
    expect(parameterValue(motion, "scale")).toBe("50");
    expect(parameterValue(motion, "rotation")).toBe("15");
    expect(motion).toMatch(
      /<parameterid>center<\/parameterid>\s*<name>Center<\/name>\s*<value>\s*<horiz>-0.2<\/horiz>\s*<vert>-0.25<\/vert>\s*<\/value>/,
    );
    const basic = motion.match(/<effectid>basic<\/effectid>([\s\S]*?)<\/effect>/)?.[1] ?? "";
    expect([...basic.matchAll(/<parameterid>([^<]+)<\/parameterid>/g)].map((match) => match[1])).toEqual([
      "scale",
      "rotation",
      "center",
    ]);
    for (const [side, amount] of [
      ["left", "10"],
      ["right", "20"],
      ["top", "5"],
      ["bottom", "15"],
    ])
      expect(parameterValue(motion, side)).toBe(amount);
    expect(Number(parameterValue(clipitem(xml, "clp_ext"), "level"))).toBeCloseTo(0.5011872336272722);
  });
  it("rejects noninteger source frames and clip rates different from the sequence", async () => {
    const { xml } = await generate("fixtures/regressions/xmeml-sequence-grid.zcut.json");
    for (const [from, to] of [
      ["<in>1</in>", "<in>1.5</in>"],
      ["<out>26</out>", "<out>26.5</out>"],
      ["<timebase>25</timebase>", "<timebase>30</timebase>"],
      ["<ntsc>FALSE</ntsc>", "<ntsc>TRUE</ntsc>"],
    ]) {
      const item = clipitem(xml, "clp_vfr");
      const altered = xml.replace(item, item.replace(from, to));
      expect(altered).not.toBe(xml);
      expect(await exporter.validate(altered)).toBe(false);
    }
    const item = clipitem(xml, "clp_vfr");
    expect(await exporter.validate(xml.replace(item, item.replace(/<rate>[\s\S]*?<\/rate>/, "")))).toBe(false);
  });
  it("checks mixed-rate source limits in sequence frames, including file references", async () => {
    const { project, timeline, paths } = await generate("fixtures/regressions/parent-25-on-2997.zcut.json");
    const track = timeline.tracks[0];
    const media = project.media.find((entry) => entry.id === "med_DUP1");
    if (track?.kind !== "video" || !track.clips[0] || !media) throw new Error("Missing mixed-rate clip");
    const clip = track.clips[0];
    clip.source_start = sub(media.duration, clip.duration);
    const xml = (await exporter.generate(project, timeline, profile, paths)).data.toString();
    const item = clipitem(xml, clip.id);
    expect(item).toMatch(/<in>298<\/in>\s*<out>300<\/out>/);
    expect(await exporter.validate(xml)).toBe(true);
    expect(await exporter.validate(xml.replace(item, item.replace("<out>300</out>", "<out>301</out>")))).toBe(false);
    const { xml: referenced } = await generate("fixtures/regressions/xmeml-sequence-grid.zcut.json");
    const tail = clipitem(referenced, "clp_tail");
    expect(tail).toContain('<file id="med_VFR"/>');
    expect(await exporter.validate(referenced.replace(tail, tail.replace("<out>750</out>", "<out>751</out>")))).toBe(
      false,
    );
  });
  it("reports audio and source grid rounding plus dropped extension data", async () => {
    const { project, timeline, paths } = await generate("fixtures/projects/std-2997-df.zcut.json");
    const video = timeline.tracks.find((track) => track.kind === "video");
    if (video?.kind !== "video" || !video.clips[0]) throw new Error("Missing video clip");
    video.clips[0].source_start = { numerator: 557n, denominator: 50n };
    const audio = timeline.tracks.find(
      (track) => track.kind === "audio" && track.clips.some((clip) => clip.id === "clp_ext"),
    );
    if (audio?.kind !== "audio") throw new Error("Missing audio clip");
    const clip = audio.clips.find((item) => item.id === "clp_ext");
    if (!clip) throw new Error("Missing external audio clip");
    clip.timeline_start = { numerator: 1n, denominator: 48000n };
    clip.ext = { note: "kept only in source" };
    const losses = exporter.losses(project, timeline, profile);
    expect(losses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_id: video.clips[0].id, feature: "clip_cut", reason_code: "R_GRID_ROUNDED" }),
        expect.objectContaining({ entity_id: clip.id, feature: "av_sync", reason_code: "R_GRID_ROUNDED" }),
        expect.objectContaining({ entity_id: clip.id, feature: "ext_data", reason_code: "R_EXT_DROPPED" }),
      ]),
    );
    const xml = (await exporter.generate(project, timeline, profile, paths)).data;
    expect(
      compareCuttingLists(cuttingList(project, timeline, profile), await exporter.readBack(xml, timeline))
        .zero_frame_deviation,
    ).toBe(true);
  });
  it("rejects broken references, source overflow, and a changed source frame", async () => {
    const { project, timeline, xml } = await generate("fixtures/projects/std-25.zcut.json");
    expect(
      await exporter.validate(
        xml.replace("<linkclipref>clp_a1</linkclipref>", "<linkclipref>clp_missing</linkclipref>"),
      ),
    ).toBe(false);
    expect(await exporter.validate(xml.replace("<out>528</out>", "<out>999999</out>"))).toBe(false);
    const altered = xml.replace("<in>278</in>", "<in>279</in>");
    expect(altered).not.toBe(xml);
    expect(
      compareCuttingLists(cuttingList(project, timeline, profile), await exporter.readBack(altered, timeline))
        .zero_frame_deviation,
    ).toBe(false);
  });
  it("creates a handoff package with SRT and a passing local validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-xmeml-"));
    try {
      const { project } = await generate("fixtures/projects/std-25.zcut.json");
      await mkdir(join(directory, "media"));
      for (const media of project.media) {
        const path = join(directory, "media", `${media.id}.bin`);
        await writeFile(path, media.id);
        media.path = `media/${media.id}.bin`;
        media.size_bytes = Buffer.byteLength(media.id);
        media.fingerprint = await fingerprint(path);
      }
      const projectPath = join(directory, "std-25.zcut.json");
      await writeFile(projectPath, serializeProject(project));
      const result = await runExport(
        project,
        { project: projectPath, output: directory },
        { ...exporter, gitSha: async () => "abcdef0" },
        "exp_xmeml_test",
        "2026-10-27T00:00:00.000Z",
        profile,
        previewStub,
      );
      if (result.rejected) throw new Error("Export rejected");
      expect(result.manifest.profile.id).toBe(profile);
      expect(result.manifest.validation.schema.status).toBe("pass");
      expect(result.manifest.validation.media_resolved.status).toBe("pass");
      expect(await readFile(join(result.package, "timeline", `${project.timelines[0]?.name}.xml`), "utf8")).toContain(
        '<xmeml version="5">',
      );
      expect(await readFile(join(result.package, "loss-report.json"), "utf8")).toContain("premiere-25-xmeml-5");
      expect(await readFile(join(result.package, "subtitles", "zh-Hans.srt"), "utf8")).toContain("-->");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("accepts the Premiere profile through the CLI export dry run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcut-xmeml-cli-"));
    try {
      const requestPath = join(directory, "request.json");
      await writeFile(
        requestPath,
        JSON.stringify({
          base_revision: "rev_fixture_1",
          idempotency_key: "xmeml-cli-dry-run",
          author: { kind: "agent", name: "test" },
          profile,
          dry_run: true,
          accept_losses: true,
        }),
      );
      const { stdout } = await promisify(execFile)(process.execPath, [
        resolve("packages/cli/dist/index.js"),
        "export",
        resolve("fixtures/projects/std-25.zcut.json"),
        "--input",
        requestPath,
      ]);
      const response = JSON.parse(stdout) as { status: string; result: { profile: string } };
      expect(response.status).toBe("dry_run");
      expect(response.result.profile).toBe(profile);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
