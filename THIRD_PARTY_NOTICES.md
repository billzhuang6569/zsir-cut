# Third-party notices

## dunce 1.0.5 (Apache-2.0)

Repository: https://gitlab.com/kornelski/dunce

Already a transitive Tauri dependency; now also a direct desktop-shell dependency
to simplify Windows resource paths before passing them to Node.js. UNC paths
that cannot be safely simplified are preserved. No upstream code is copied.

Copyright Kornel Lesiński and contributors. Used under the Apache-2.0 option
of the upstream `CC0-1.0 OR MIT-0 OR Apache-2.0` license expression. The complete
Apache License, Version 2.0 is reproduced at the end of this file so that it
also accompanies the bundled runtime.

## wavesurfer.js

Repository: https://github.com/katspaugh/wavesurfer.js

Commit: `cdef4ac6c2744b3e376cae4e5a727e375137fb9d`

Adapted `src/renderer.ts` and `src/renderer-utils.ts` (bar interval maxima, DPR, visible Canvas chunks) in `packages/desktop/src/Wave.tsx`.

BSD 3-Clause License

Copyright (c) 2012-2023, katspaugh and contributors
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice, this
  list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## opencut-classic (MIT)

Repository: https://github.com/OpenCut-app/opencut-classic

Commit: `cf5e79e919144200294fb9fed22a222592a0aeea`

Referenced and adapted `apps/web/src/timeline/components/audio-waveform.tsx` (viewport geometry, draw signature) and `apps/web/src/services/waveform-cache/service.ts` (source Promise reuse) in `packages/desktop/src/Wave.tsx`. No decoder or runtime dependency imported.

Copyright 2025-2026 OpenCut

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### R1.9 timeline gestures

Additionally referenced and adapted these opencut-classic files at the same commit in `packages/desktop/src/useTimelineGestures.ts` and `packages/desktop/src/TimelinePreview.tsx`:

- `apps/web/src/timeline/controllers/element-interaction-controller.ts` (pending gesture, drag threshold, lifecycle)
- `apps/web/src/timeline/controllers/zoom-controller.ts` (wheel normalization, playhead anchor, scroll after layout)
- `apps/web/src/timeline/components/selection-hit-testing.ts` (content coordinates, rectangle intersection)

The OpenCut copyright and MIT permission notice above apply. The WASM time model and runtime dependencies were not imported; timeline time remains rational.

## openreel-video (MIT)

Repository: https://github.com/Augani/openreel-video

Commit: `367d7e90b61b5181f9861b852bb8b9d7a7d2954a`

Referenced and adapted `apps/web/src/components/editor/Timeline.tsx` (marquee selection, suppressing its trailing background click) in `packages/desktop/src/useTimelineGestures.ts`. No runtime dependencies imported.

MIT License

Copyright (c) 2024-2026 Augustus Otu and Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### R1.9 PR 2: clip move and snapping

Additionally adapted `apps/web/src/timeline/controllers/element-interaction-controller.ts`
(move group, grab offset, preview/commit) and `apps/web/src/timeline/snapping/resolve.ts`
(nearest distance) from OpenCut-app/opencut-classic at
`cf5e79e919144200294fb9fed22a222592a0aeea` in
`packages/desktop/src/timelineMove.ts` and `packages/desktop/src/TimelinePreview.tsx`.
The OpenCut copyright and MIT notice above apply. Core remains responsible for
linked moves, cross-track validation, conflicts and persistence.

## react-timeline-editor (MIT)

Repository: https://github.com/xzdarcy/react-timeline-editor

Commit: `4148f4a837dd767ea66807560d05bc7b65c7e578`

Adapted `packages/timeline/src/components/row_rnd/row_rnd.tsx` (both-edge snapping)
in `packages/desktop/src/timelineMove.ts`. The nearest distance is updated for
every winning candidate; no floating point time model or runtime dependency imported.

MIT License

Copyright (c) 2021 zdarcy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### R1.9 PR 3: clip trim

Additionally adapted `apps/web/src/timeline/controllers/resize-controller.ts`
(shared source/neighbor bounds, preview/discard/commit lifecycle) from
OpenCut-app/opencut-classic at `cf5e79e919144200294fb9fed22a222592a0aeea`
in `packages/desktop/src/timelineTrim.ts` and `packages/desktop/src/TimelinePreview.tsx`.
The OpenCut copyright and MIT notice above apply. Existing rational snapping,
overlap checks and gesture lifecycle are reused; no WASM or runtime dependency imported.

## Roboto (Apache-2.0)

Repository: https://github.com/googlefonts/roboto

Version: `2.001047; 2015` (font metadata).

Copyright 2015 Google Inc. All Rights Reserved.

Bundled `fixtures/fonts/Roboto-Regular.ttf` for subtitle rendering tests only,
registered as `ZcutTestRoboto`. Copyright and font metadata are retained in the
unmodified font. The Apache License, Version 2.0 is included in
[fixtures/fonts/LICENSE.txt](fixtures/fonts/LICENSE.txt).

### S4.6 subtitle animation

Adapted `packages/core/src/text/caption-animation-renderer.ts` (active word,
completed word and karaoke fill states) from openreel-video at
`367d7e90b61b5181f9861b852bb8b9d7a7d2954a` in
`packages/exporters/src/subtitle-render.ts`. The OpenReel copyright and MIT
permission notice above apply. Time and easing use bigint rationals; no runtime
dependency imported.

## Node.js 24 (MIT and bundled third-party licenses)

Repository: https://github.com/nodejs/node

The release includes only the platform's Node.js 24 executable, with its complete
upstream `LICENSE` copied to `runtime/NODE-LICENSE.txt`. This file contains the
Node.js MIT license and the notices/licenses for components embedded in Node.
Local downloads are checked against the matching official `SHASUMS256.txt`; CI
uses the Node 24 installation provided by `actions/setup-node`. npm, corepack and
headers are not distributed. No new Node package is added for this runtime.

Node.js is licensed for use as follows:

"""
Copyright Node.js contributors. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""

This license applies to parts of Node.js originating from the
https://github.com/joyent/node repository:

"""
Copyright Joyent, Inc. and other Node contributors. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.
"""

## cross-spawn 7.0.6 (MIT)

Repository: https://github.com/moxystudio/node-cross-spawn

Already a transitive dependency of the MCP SDK; now also a direct app-host
dependency for Windows executable and cmd launcher support.

The MIT License (MIT)

Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## FFmpeg and ffprobe 9.0.2 (GPL)

FFmpeg and ffprobe are independent executable programs, invoked as subprocesses;
they are not linked into zsir-cut. The release bundles them in `runtime/bin/`.
The complete GPL v3 text is included as `runtime/FFMPEG-GPL-3.0.txt` (from
`scripts/licenses/GPL-3.0.txt`); Windows also retains the archive's `LICENSE.txt`
as `runtime/FFMPEG-UPSTREAM-LICENSE.txt`.

Fixed binary sources (each archive is checked against its pinned SHA-256 in
`scripts/package-release.mjs` before extraction):

- macOS arm64, martin-riedl.de:
  https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip
  and https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip
- Windows x64, BtbN FFmpeg-Builds, `n9.0.2-48-gd4070a14ce`, GPL build:
  https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-08-12-35/ffmpeg-n9.0.2-48-gd4070a14ce-win64-gpl-9.0.zip

ffmpeg 是独立程序，源码随 GitHub Release 提供，也可从
https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz 获取。
Publishing a GitHub Release must include the corresponding source and licenses,
including build-specific changes and bundled components; an installer build alone
does not publish those source artifacts.

## Python 3.13.18 and ASR environment (macOS only)

Runtime source: python-build-standalone, release `20261026`:
https://github.com/astral-sh/python-build-standalone/releases/download/20261026/cpython-3.13.18%2B20261026-aarch64-apple-darwin-install_only_stripped.tar.gz

CPython uses the Python Software Foundation License (PSF-2.0) and bundled
third-party licenses. Upstream license files remain in `runtime/python/`.
Dependencies are installed from `workers/asr/requirements.lock`; their upstream
license files and distribution metadata are retained. Each build also writes
`runtime/PYTHON-PACKAGES.json` containing installed names, versions and license
metadata. Models are not bundled. pip, ensurepip, test directories and bytecode
caches are removed after installation.

Main locked dependencies:

| Package | Version | Upstream license metadata |
| --- | --- | --- |
| mlx / mlx-metal | 0.32.4 | MIT |
| mlx-audio | 0.5.8 | MIT |
| jieba | 0.42.1 | MIT |
| numpy | 2.5.4 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| scipy | 1.18.1 | BSD-3-Clause; wheel notices also list OpenBLAS/LAPACK, GCC runtime and libquadmath |
| transformers | 5.21.0 | Apache-2.0 |
| huggingface_hub | 2.3.0 | Apache-2.0 |
| tokenizers | 0.23.3 | Apache-2.0 |
| safetensors | 0.8.0 | Apache-2.0 |
| miniaudio | 1.71 | MIT |
| sounddevice | 0.5.6 | MIT (bundled PortAudio notices retained) |
| cffi | 2.1.1 | MIT-0 |
| regex | 2026.9.29 | Apache-2.0 AND CNRI-Python |
| tqdm | 4.70.1 | MPL-2.0 AND MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |

License metadata was checked against the locally installed versions matching the
lockfile. PSF-2.0, MIT-0, Zlib, CC0-1.0, CNRI-Python and MPL-2.0 are outside the
repository's literal MIT/Apache-2.0/BSD/ISC allowlist. SciPy's wheel notices also
mention GPL-3.0-or-later WITH GCC-exception-3.1 and LGPL-2.1-or-later; actual bundled
libraries depend on the platform wheel. These require a spec/license decision
before distribution. The lockfile is unchanged; no dependency was substituted.

## Apache License, Version 2.0 (dunce)

```text
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
