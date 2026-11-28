# OPEN SOURCE INVENTORY — BEAN FX

Audit of the dependencies ACTUALLY INSTALLED by this repository's lockfile — every install path (instance), not just convenient top-level packages. Generated 2026-11-28T01:24:22.524Z by `scripts/generate-open-source-audit.mjs`. Regenerate after dependency changes. Classification rules: never guessed — an instance whose license cannot be confidently established is labeled UNRESOLVED and excluded from commercial distribution until resolved.

## Model — entries vs instances vs unique packages

| Measure | Count |
|---|---|
| Lockfile entries (node_modules/** paths) | 1008 |
| Production instances (installed for the product) | 584 |
| Development-only instances (dev tooling, scope `excluded`) | 424 |
| Unique production package NAMES | 548 |
| Unique production name@version pairs | 570 |
| Nested production instances | 37 |
| Nested instances whose version differs from the top-level copy | 37 |
| Instances with UNRESOLVED license evidence | 0 |

Why these differ: npm's lockfile records one entry per INSTALL PATH. A package can be installed several times at different versions under different parents (e.g. `react-is@17.0.2` nested under @codesandbox/sandpack-react while the top level carries 18.3.1). A complete inventory must describe the instances actually installed — collapsing by name would hide version conflicts that matter for licenses and security.

## 1. Integrated dependencies — production instances

| Instance (name@version) | Install path | Scope | License | Evidence | Classification |
|---|---|---|---|---|---|
| @babel/runtime@7.28.6 | node_modules/@babel/runtime | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/autocomplete@6.20.0 | node_modules/@codemirror/autocomplete | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/commands@6.10.1 | node_modules/@codemirror/commands | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-angular@0.1.4 | node_modules/@codemirror/lang-angular | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-cpp@6.0.3 | node_modules/@codemirror/lang-cpp | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-css@6.3.1 | node_modules/@codemirror/lang-css | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-go@6.0.1 | node_modules/@codemirror/lang-go | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-html@6.4.11 | node_modules/@codemirror/lang-html | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-java@6.0.2 | node_modules/@codemirror/lang-java | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-javascript@6.2.4 | node_modules/@codemirror/lang-javascript | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-jinja@6.0.0 | node_modules/@codemirror/lang-jinja | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-json@6.0.2 | node_modules/@codemirror/lang-json | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-less@6.0.2 | node_modules/@codemirror/lang-less | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-liquid@6.3.1 | node_modules/@codemirror/lang-liquid | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-markdown@6.5.0 | node_modules/@codemirror/lang-markdown | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-php@6.0.2 | node_modules/@codemirror/lang-php | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-python@6.2.1 | node_modules/@codemirror/lang-python | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-rust@6.0.2 | node_modules/@codemirror/lang-rust | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-sass@6.0.2 | node_modules/@codemirror/lang-sass | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-sql@6.10.0 | node_modules/@codemirror/lang-sql | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-vue@0.1.3 | node_modules/@codemirror/lang-vue | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-wast@6.0.2 | node_modules/@codemirror/lang-wast | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-xml@6.1.0 | node_modules/@codemirror/lang-xml | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lang-yaml@6.1.2 | node_modules/@codemirror/lang-yaml | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/language@6.12.1 | node_modules/@codemirror/language | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/language-data@6.5.2 | node_modules/@codemirror/language-data | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/legacy-modes@6.5.2 | node_modules/@codemirror/legacy-modes | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/lint@6.9.2 | node_modules/@codemirror/lint | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/merge@6.11.2 | node_modules/@codemirror/merge | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/search@6.6.0 | node_modules/@codemirror/search | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/state@6.5.4 | node_modules/@codemirror/state | transitive | MIT | installed-package | PERMISSIVE |
| @codemirror/view@6.39.11 | node_modules/@codemirror/view | transitive | MIT | installed-package | PERMISSIVE |
| @codesandbox/nodebox@0.1.8 | node_modules/@codesandbox/nodebox | transitive | SEE LICENSE IN ./LICENSE | installed-package | NON-STANDARD |
| @codesandbox/sandpack-client@2.19.8 | node_modules/@codesandbox/sandpack-client | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @codesandbox/sandpack-react@2.20.0 | node_modules/@codesandbox/sandpack-react | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| react-is@17.0.2 | node_modules/@codesandbox/sandpack-react/node_modules/react-is | transitive | MIT | npm-registry | PERMISSIVE |
| @date-fns/tz@1.4.1 | node_modules/@date-fns/tz | transitive | MIT | installed-package | PERMISSIVE |
| @dnd-kit/accessibility@3.1.1 | node_modules/@dnd-kit/accessibility | transitive | MIT | installed-package | PERMISSIVE |
| @dnd-kit/core@6.3.1 | node_modules/@dnd-kit/core | direct | MIT | installed-package | PERMISSIVE |
| @dnd-kit/sortable@10.0.0 | node_modules/@dnd-kit/sortable | direct | MIT | installed-package | PERMISSIVE |
| @dnd-kit/utilities@3.2.2 | node_modules/@dnd-kit/utilities | direct | MIT | installed-package | PERMISSIVE |
| @eloqnt/config@0.1.2 | node_modules/@eloqnt/config | transitive | MIT | installed-package | PERMISSIVE |
| @eloqnt/extractor@0.1.0 | node_modules/@eloqnt/extractor | transitive | MIT | installed-package | PERMISSIVE |
| @eloqnt/format-json@0.1.1 | node_modules/@eloqnt/format-json | transitive | MIT | installed-package | PERMISSIVE |
| @eloqnt/format-po@0.1.2 | node_modules/@eloqnt/format-po | transitive | MIT | installed-package | PERMISSIVE |
| @eloqnt/messages@0.1.0 | node_modules/@eloqnt/messages | transitive | MIT | installed-package | PERMISSIVE |
| @emnapi/runtime@1.11.3 | node_modules/@emnapi/runtime | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @floating-ui/core@1.7.3 | node_modules/@floating-ui/core | transitive | MIT | installed-package | PERMISSIVE |
| @floating-ui/dom@1.7.4 | node_modules/@floating-ui/dom | transitive | MIT | installed-package | PERMISSIVE |
| @floating-ui/react@0.27.16 | node_modules/@floating-ui/react | transitive | MIT | installed-package | PERMISSIVE |
| @floating-ui/react-dom@2.1.6 | node_modules/@floating-ui/react-dom | transitive | MIT | installed-package | PERMISSIVE |
| @floating-ui/utils@0.2.10 | node_modules/@floating-ui/utils | transitive | MIT | installed-package | PERMISSIVE |
| @formatjs/fast-memoize@3.1.7 | node_modules/@formatjs/fast-memoize | transitive | MIT | installed-package | PERMISSIVE |
| @formatjs/icu-messageformat-parser@3.5.23 | node_modules/@formatjs/icu-messageformat-parser | transitive | MIT | installed-package | PERMISSIVE |
| @formatjs/icu-skeleton-parser@2.1.13 | node_modules/@formatjs/icu-skeleton-parser | transitive | MIT | installed-package | PERMISSIVE |
| @formatjs/intl-localematcher@0.8.14 | node_modules/@formatjs/intl-localematcher | transitive | MIT | installed-package | PERMISSIVE |
| @hookform/resolvers@5.2.2 | node_modules/@hookform/resolvers | direct | MIT | installed-package | PERMISSIVE |
| @img/colour@1.1.0 | node_modules/@img/colour | transitive | MIT | installed-package | PERMISSIVE |
| @img/sharp-darwin-arm64@0.35.5 | node_modules/@img/sharp-darwin-arm64 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-darwin-x64@0.35.5 | node_modules/@img/sharp-darwin-x64 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-freebsd-wasm32@0.35.5 | node_modules/@img/sharp-freebsd-wasm32 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-libvips-darwin-arm64@1.3.4 | node_modules/@img/sharp-libvips-darwin-arm64 | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-libvips-darwin-x64@1.3.4 | node_modules/@img/sharp-libvips-darwin-x64 | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-libvips-linux-arm@1.3.4 | node_modules/@img/sharp-libvips-linux-arm | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-libvips-linux-arm64@1.3.4 | node_modules/@img/sharp-libvips-linux-arm64 | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-libvips-linux-ppc64@1.3.4 | node_modules/@img/sharp-libvips-linux-ppc64 | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-libvips-linux-riscv64@1.3.4 | node_modules/@img/sharp-libvips-linux-riscv64 | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-libvips-linux-s390x@1.3.4 | node_modules/@img/sharp-libvips-linux-s390x | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-libvips-linux-x64@1.3.4 | node_modules/@img/sharp-libvips-linux-x64 | transitive (optional) | LGPL-3.0-or-later | installed-package | COPYLEFT-WEAK |
| @img/sharp-libvips-linuxmusl-arm64@1.3.4 | node_modules/@img/sharp-libvips-linuxmusl-arm64 | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-libvips-linuxmusl-x64@1.3.4 | node_modules/@img/sharp-libvips-linuxmusl-x64 | transitive (optional) | LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-linux-arm@0.35.5 | node_modules/@img/sharp-linux-arm | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-linux-arm64@0.35.5 | node_modules/@img/sharp-linux-arm64 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-linux-ppc64@0.35.5 | node_modules/@img/sharp-linux-ppc64 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-linux-riscv64@0.35.5 | node_modules/@img/sharp-linux-riscv64 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-linux-s390x@0.35.5 | node_modules/@img/sharp-linux-s390x | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-linux-x64@0.35.5 | node_modules/@img/sharp-linux-x64 | transitive (optional) | Apache-2.0 | installed-package | PERMISSIVE |
| @img/sharp-linuxmusl-arm64@0.35.5 | node_modules/@img/sharp-linuxmusl-arm64 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-linuxmusl-x64@0.35.5 | node_modules/@img/sharp-linuxmusl-x64 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-wasm32@0.35.5 | node_modules/@img/sharp-wasm32 | transitive (optional) | Apache-2.0 AND LGPL-3.0-or-later AND MIT | npm-registry | COPYLEFT-WEAK |
| @img/sharp-webcontainers-wasm32@0.35.5 | node_modules/@img/sharp-webcontainers-wasm32 | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @img/sharp-win32-arm64@0.35.5 | node_modules/@img/sharp-win32-arm64 | transitive (optional) | Apache-2.0 AND LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-win32-ia32@0.35.5 | node_modules/@img/sharp-win32-ia32 | transitive (optional) | Apache-2.0 AND LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @img/sharp-win32-x64@0.35.5 | node_modules/@img/sharp-win32-x64 | transitive (optional) | Apache-2.0 AND LGPL-3.0-or-later | npm-registry | COPYLEFT-WEAK |
| @lexical/clipboard@0.35.0 | node_modules/@lexical/clipboard | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/code@0.35.0 | node_modules/@lexical/code | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/devtools-core@0.35.0 | node_modules/@lexical/devtools-core | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/dragon@0.35.0 | node_modules/@lexical/dragon | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/hashtag@0.35.0 | node_modules/@lexical/hashtag | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/history@0.35.0 | node_modules/@lexical/history | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/html@0.35.0 | node_modules/@lexical/html | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/link@0.35.0 | node_modules/@lexical/link | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/list@0.35.0 | node_modules/@lexical/list | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/mark@0.35.0 | node_modules/@lexical/mark | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/markdown@0.35.0 | node_modules/@lexical/markdown | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/offset@0.35.0 | node_modules/@lexical/offset | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/overflow@0.35.0 | node_modules/@lexical/overflow | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/plain-text@0.35.0 | node_modules/@lexical/plain-text | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/react@0.35.0 | node_modules/@lexical/react | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/rich-text@0.35.0 | node_modules/@lexical/rich-text | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/selection@0.35.0 | node_modules/@lexical/selection | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/table@0.35.0 | node_modules/@lexical/table | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/text@0.35.0 | node_modules/@lexical/text | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/utils@0.35.0 | node_modules/@lexical/utils | transitive | MIT | installed-package | PERMISSIVE |
| @lexical/yjs@0.35.0 | node_modules/@lexical/yjs | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/common@1.5.0 | node_modules/@lezer/common | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/cpp@1.1.5 | node_modules/@lezer/cpp | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/css@1.3.0 | node_modules/@lezer/css | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/go@1.0.1 | node_modules/@lezer/go | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/highlight@1.2.3 | node_modules/@lezer/highlight | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/html@1.3.13 | node_modules/@lezer/html | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/java@1.1.3 | node_modules/@lezer/java | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/javascript@1.5.4 | node_modules/@lezer/javascript | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/json@1.0.3 | node_modules/@lezer/json | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/lr@1.4.7 | node_modules/@lezer/lr | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/markdown@1.6.3 | node_modules/@lezer/markdown | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/php@1.0.5 | node_modules/@lezer/php | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/python@1.1.18 | node_modules/@lezer/python | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/rust@1.0.2 | node_modules/@lezer/rust | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/sass@1.1.0 | node_modules/@lezer/sass | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/xml@1.0.6 | node_modules/@lezer/xml | transitive | MIT | installed-package | PERMISSIVE |
| @lezer/yaml@1.0.3 | node_modules/@lezer/yaml | transitive | MIT | installed-package | PERMISSIVE |
| @marijn/find-cluster-break@1.0.2 | node_modules/@marijn/find-cluster-break | transitive | MIT | installed-package | PERMISSIVE |
| @mdxeditor/editor@3.52.3 | node_modules/@mdxeditor/editor | direct | MIT | installed-package | PERMISSIVE |
| @mdxeditor/gurx@1.2.4 | node_modules/@mdxeditor/gurx | transitive | MIT | installed-package | PERMISSIVE |
| @microsoft/fetch-event-source@2.0.1 | node_modules/@microsoft/fetch-event-source | transitive | MIT | installed-package | PERMISSIVE |
| @next/env@16.4.6 | node_modules/@next/env | transitive | MIT | installed-package | PERMISSIVE |
| @next/swc-darwin-arm64@16.4.6 | node_modules/@next/swc-darwin-arm64 | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @next/swc-darwin-x64@16.4.6 | node_modules/@next/swc-darwin-x64 | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @next/swc-linux-arm64-gnu@16.4.6 | node_modules/@next/swc-linux-arm64-gnu | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @next/swc-linux-arm64-musl@16.4.6 | node_modules/@next/swc-linux-arm64-musl | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @next/swc-linux-x64-gnu@16.4.6 | node_modules/@next/swc-linux-x64-gnu | transitive (optional) | MIT | installed-package | PERMISSIVE |
| @next/swc-linux-x64-musl@16.4.6 | node_modules/@next/swc-linux-x64-musl | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @next/swc-win32-arm64-msvc@16.4.6 | node_modules/@next/swc-win32-arm64-msvc | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @next/swc-win32-x64-msvc@16.4.6 | node_modules/@next/swc-win32-x64-msvc | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @open-draft/deferred-promise@2.2.0 | node_modules/@open-draft/deferred-promise | transitive | MIT | installed-package | PERMISSIVE |
| @panva/hkdf@1.2.1 | node_modules/@panva/hkdf | transitive | MIT | installed-package | PERMISSIVE |
| @parcel/watcher@2.6.0 | node_modules/@parcel/watcher | transitive | MIT | installed-package | PERMISSIVE |
| @parcel/watcher-android-arm64@2.6.0 | node_modules/@parcel/watcher-android-arm64 | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-darwin-arm64@2.6.0 | node_modules/@parcel/watcher-darwin-arm64 | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-darwin-x64@2.6.0 | node_modules/@parcel/watcher-darwin-x64 | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-freebsd-x64@2.6.0 | node_modules/@parcel/watcher-freebsd-x64 | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-linux-arm-glibc@2.6.0 | node_modules/@parcel/watcher-linux-arm-glibc | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-linux-arm-musl@2.6.0 | node_modules/@parcel/watcher-linux-arm-musl | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-linux-arm64-glibc@2.6.0 | node_modules/@parcel/watcher-linux-arm64-glibc | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-linux-arm64-musl@2.6.0 | node_modules/@parcel/watcher-linux-arm64-musl | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-linux-x64-glibc@2.6.0 | node_modules/@parcel/watcher-linux-x64-glibc | transitive (optional) | MIT | installed-package | PERMISSIVE |
| @parcel/watcher-linux-x64-musl@2.6.0 | node_modules/@parcel/watcher-linux-x64-musl | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-win32-arm64@2.6.0 | node_modules/@parcel/watcher-win32-arm64 | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @parcel/watcher-win32-x64@2.6.0 | node_modules/@parcel/watcher-win32-x64 | transitive (optional) | MIT | npm-registry | PERMISSIVE |
| @prisma/client@6.19.2 | node_modules/@prisma/client | direct | Apache-2.0 | installed-package | PERMISSIVE |
| @prisma/config@6.19.2 | node_modules/@prisma/config | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @prisma/debug@6.19.2 | node_modules/@prisma/debug | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @prisma/engines@6.19.2 | node_modules/@prisma/engines | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @prisma/engines-version@7.1.1-3.c2990dca591cba766e3b7ef5d9e8a84796e47ab7 | node_modules/@prisma/engines-version | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @prisma/fetch-engine@6.19.2 | node_modules/@prisma/fetch-engine | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @prisma/get-platform@6.19.2 | node_modules/@prisma/get-platform | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @radix-ui/colors@3.0.0 | node_modules/@radix-ui/colors | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/number@1.1.1 | node_modules/@radix-ui/number | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/primitive@1.1.3 | node_modules/@radix-ui/primitive | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-accordion@1.2.12 | node_modules/@radix-ui/react-accordion | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-alert-dialog@1.1.15 | node_modules/@radix-ui/react-alert-dialog | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.3 | node_modules/@radix-ui/react-alert-dialog/node_modules/@radix-ui/react-slot | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-arrow@1.1.7 | node_modules/@radix-ui/react-arrow | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-aspect-ratio@1.1.8 | node_modules/@radix-ui/react-aspect-ratio | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-primitive@2.1.4 | node_modules/@radix-ui/react-aspect-ratio/node_modules/@radix-ui/react-primitive | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-avatar@1.1.11 | node_modules/@radix-ui/react-avatar | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-context@1.1.3 | node_modules/@radix-ui/react-avatar/node_modules/@radix-ui/react-context | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-primitive@2.1.4 | node_modules/@radix-ui/react-avatar/node_modules/@radix-ui/react-primitive | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-checkbox@1.3.3 | node_modules/@radix-ui/react-checkbox | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-collapsible@1.1.12 | node_modules/@radix-ui/react-collapsible | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-collection@1.1.7 | node_modules/@radix-ui/react-collection | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.3 | node_modules/@radix-ui/react-collection/node_modules/@radix-ui/react-slot | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-compose-refs@1.1.2 | node_modules/@radix-ui/react-compose-refs | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-context@1.1.2 | node_modules/@radix-ui/react-context | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-context-menu@2.2.16 | node_modules/@radix-ui/react-context-menu | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-dialog@1.1.15 | node_modules/@radix-ui/react-dialog | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.3 | node_modules/@radix-ui/react-dialog/node_modules/@radix-ui/react-slot | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-direction@1.1.1 | node_modules/@radix-ui/react-direction | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-dismissable-layer@1.1.11 | node_modules/@radix-ui/react-dismissable-layer | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-dropdown-menu@2.1.16 | node_modules/@radix-ui/react-dropdown-menu | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-focus-guards@1.1.3 | node_modules/@radix-ui/react-focus-guards | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-focus-scope@1.1.7 | node_modules/@radix-ui/react-focus-scope | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-hover-card@1.1.15 | node_modules/@radix-ui/react-hover-card | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-icons@1.3.2 | node_modules/@radix-ui/react-icons | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-id@1.1.1 | node_modules/@radix-ui/react-id | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-label@2.1.8 | node_modules/@radix-ui/react-label | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-primitive@2.1.4 | node_modules/@radix-ui/react-label/node_modules/@radix-ui/react-primitive | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-menu@2.1.16 | node_modules/@radix-ui/react-menu | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.3 | node_modules/@radix-ui/react-menu/node_modules/@radix-ui/react-slot | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-menubar@1.1.16 | node_modules/@radix-ui/react-menubar | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-navigation-menu@1.2.14 | node_modules/@radix-ui/react-navigation-menu | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-popover@1.1.15 | node_modules/@radix-ui/react-popover | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.3 | node_modules/@radix-ui/react-popover/node_modules/@radix-ui/react-slot | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-popper@1.2.8 | node_modules/@radix-ui/react-popper | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-portal@1.1.9 | node_modules/@radix-ui/react-portal | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-presence@1.1.5 | node_modules/@radix-ui/react-presence | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-primitive@2.1.3 | node_modules/@radix-ui/react-primitive | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.3 | node_modules/@radix-ui/react-primitive/node_modules/@radix-ui/react-slot | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-progress@1.1.8 | node_modules/@radix-ui/react-progress | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-context@1.1.3 | node_modules/@radix-ui/react-progress/node_modules/@radix-ui/react-context | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-primitive@2.1.4 | node_modules/@radix-ui/react-progress/node_modules/@radix-ui/react-primitive | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-radio-group@1.3.8 | node_modules/@radix-ui/react-radio-group | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-roving-focus@1.1.11 | node_modules/@radix-ui/react-roving-focus | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-scroll-area@1.2.10 | node_modules/@radix-ui/react-scroll-area | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-select@2.2.6 | node_modules/@radix-ui/react-select | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.3 | node_modules/@radix-ui/react-select/node_modules/@radix-ui/react-slot | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-separator@1.1.8 | node_modules/@radix-ui/react-separator | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-primitive@2.1.4 | node_modules/@radix-ui/react-separator/node_modules/@radix-ui/react-primitive | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-slider@1.3.6 | node_modules/@radix-ui/react-slider | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.4 | node_modules/@radix-ui/react-slot | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-switch@1.2.6 | node_modules/@radix-ui/react-switch | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-tabs@1.1.13 | node_modules/@radix-ui/react-tabs | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-toast@1.2.15 | node_modules/@radix-ui/react-toast | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-toggle@1.1.10 | node_modules/@radix-ui/react-toggle | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-toggle-group@1.1.11 | node_modules/@radix-ui/react-toggle-group | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-toolbar@1.1.11 | node_modules/@radix-ui/react-toolbar | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-separator@1.1.7 | node_modules/@radix-ui/react-toolbar/node_modules/@radix-ui/react-separator | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-tooltip@1.2.8 | node_modules/@radix-ui/react-tooltip | direct | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-slot@1.2.3 | node_modules/@radix-ui/react-tooltip/node_modules/@radix-ui/react-slot | transitive | MIT | npm-registry | PERMISSIVE |
| @radix-ui/react-use-callback-ref@1.1.1 | node_modules/@radix-ui/react-use-callback-ref | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-use-controllable-state@1.2.2 | node_modules/@radix-ui/react-use-controllable-state | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-use-effect-event@0.0.2 | node_modules/@radix-ui/react-use-effect-event | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-use-escape-keydown@1.1.1 | node_modules/@radix-ui/react-use-escape-keydown | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-use-is-hydrated@0.1.0 | node_modules/@radix-ui/react-use-is-hydrated | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-use-layout-effect@1.1.1 | node_modules/@radix-ui/react-use-layout-effect | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-use-previous@1.1.1 | node_modules/@radix-ui/react-use-previous | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-use-rect@1.1.1 | node_modules/@radix-ui/react-use-rect | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-use-size@1.1.1 | node_modules/@radix-ui/react-use-size | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/react-visually-hidden@1.2.3 | node_modules/@radix-ui/react-visually-hidden | transitive | MIT | installed-package | PERMISSIVE |
| @radix-ui/rect@1.1.1 | node_modules/@radix-ui/rect | transitive | MIT | installed-package | PERMISSIVE |
| @react-hook/intersection-observer@3.1.2 | node_modules/@react-hook/intersection-observer | transitive | MIT | installed-package | PERMISSIVE |
| @react-hook/passive-layout-effect@1.2.1 | node_modules/@react-hook/passive-layout-effect | transitive | MIT | installed-package | PERMISSIVE |
| @reactuses/core@6.1.9 | node_modules/@reactuses/core | direct | Unlicense | installed-package | PERMISSIVE |
| @schummar/icu-type-parser@1.21.5 | node_modules/@schummar/icu-type-parser | transitive | MIT | installed-package | PERMISSIVE |
| @standard-schema/spec@1.1.0 | node_modules/@standard-schema/spec | transitive | MIT | installed-package | PERMISSIVE |
| @standard-schema/utils@0.3.0 | node_modules/@standard-schema/utils | transitive | MIT | installed-package | PERMISSIVE |
| @stitches/core@1.2.8 | node_modules/@stitches/core | transitive | MIT | installed-package | PERMISSIVE |
| @swc/core@1.16.22 | node_modules/@swc/core | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @swc/core-darwin-arm64@1.16.22 | node_modules/@swc/core-darwin-arm64 | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-darwin-x64@1.16.22 | node_modules/@swc/core-darwin-x64 | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-linux-arm-gnueabihf@1.16.22 | node_modules/@swc/core-linux-arm-gnueabihf | transitive (optional) | Apache-2.0 | npm-registry | PERMISSIVE |
| @swc/core-linux-arm64-gnu@1.16.22 | node_modules/@swc/core-linux-arm64-gnu | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-linux-arm64-musl@1.16.22 | node_modules/@swc/core-linux-arm64-musl | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-linux-ppc64-gnu@1.16.22 | node_modules/@swc/core-linux-ppc64-gnu | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-linux-s390x-gnu@1.16.22 | node_modules/@swc/core-linux-s390x-gnu | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-linux-x64-gnu@1.16.22 | node_modules/@swc/core-linux-x64-gnu | transitive (optional) | Apache-2.0 AND MIT | installed-package | PERMISSIVE |
| @swc/core-linux-x64-musl@1.16.22 | node_modules/@swc/core-linux-x64-musl | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-win32-arm64-msvc@1.16.22 | node_modules/@swc/core-win32-arm64-msvc | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-win32-ia32-msvc@1.16.22 | node_modules/@swc/core-win32-ia32-msvc | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/core-win32-x64-msvc@1.16.22 | node_modules/@swc/core-win32-x64-msvc | transitive (optional) | Apache-2.0 AND MIT | npm-registry | PERMISSIVE |
| @swc/counter@0.1.3 | node_modules/@swc/counter | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @swc/helpers@0.5.23 | node_modules/@swc/helpers | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @swc/types@0.1.28 | node_modules/@swc/types | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| @tanstack/query-core@5.90.19 | node_modules/@tanstack/query-core | transitive | MIT | installed-package | PERMISSIVE |
| @tanstack/react-query@5.90.19 | node_modules/@tanstack/react-query | direct | MIT | installed-package | PERMISSIVE |
| @tanstack/react-table@8.21.3 | node_modules/@tanstack/react-table | direct | MIT | installed-package | PERMISSIVE |
| @tanstack/table-core@8.21.3 | node_modules/@tanstack/table-core | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-array@3.2.2 | node_modules/@types/d3-array | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-color@3.1.3 | node_modules/@types/d3-color | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-ease@3.0.2 | node_modules/@types/d3-ease | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-interpolate@3.0.4 | node_modules/@types/d3-interpolate | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-path@3.1.1 | node_modules/@types/d3-path | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-scale@4.0.9 | node_modules/@types/d3-scale | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-shape@3.1.8 | node_modules/@types/d3-shape | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-time@3.0.4 | node_modules/@types/d3-time | transitive | MIT | installed-package | PERMISSIVE |
| @types/d3-timer@3.0.2 | node_modules/@types/d3-timer | transitive | MIT | installed-package | PERMISSIVE |
| @types/debug@4.1.12 | node_modules/@types/debug | transitive | MIT | installed-package | PERMISSIVE |
| @types/estree@1.0.8 | node_modules/@types/estree | transitive | MIT | installed-package | PERMISSIVE |
| @types/estree-jsx@1.0.5 | node_modules/@types/estree-jsx | transitive | MIT | installed-package | PERMISSIVE |
| @types/hast@3.0.4 | node_modules/@types/hast | transitive | MIT | installed-package | PERMISSIVE |
| @types/mdast@4.0.4 | node_modules/@types/mdast | transitive | MIT | installed-package | PERMISSIVE |
| @types/ms@2.1.0 | node_modules/@types/ms | transitive | MIT | installed-package | PERMISSIVE |
| @types/react@19.2.8 | node_modules/@types/react | transitive | MIT | installed-package | PERMISSIVE |
| @types/react-dom@19.2.3 | node_modules/@types/react-dom | transitive | MIT | installed-package | PERMISSIVE |
| @types/unist@3.0.3 | node_modules/@types/unist | transitive | MIT | installed-package | PERMISSIVE |
| @ungap/structured-clone@1.3.0 | node_modules/@ungap/structured-clone | transitive | ISC | installed-package | PERMISSIVE |
| acorn@8.15.0 | node_modules/acorn | transitive | MIT | installed-package | PERMISSIVE |
| acorn-jsx@5.3.2 | node_modules/acorn-jsx | transitive | MIT | installed-package | PERMISSIVE |
| anser@2.3.5 | node_modules/anser | transitive | MIT | installed-package | PERMISSIVE |
| argparse@2.0.1 | node_modules/argparse | transitive | Python-2.0 | installed-package | PERMISSIVE |
| aria-hidden@1.2.6 | node_modules/aria-hidden | transitive | MIT | installed-package | PERMISSIVE |
| bail@2.0.2 | node_modules/bail | transitive | MIT | installed-package | PERMISSIVE |
| base64-js@1.5.1 | node_modules/base64-js | transitive | MIT | installed-package | PERMISSIVE |
| baseline-browser-mapping@2.11.40 | node_modules/baseline-browser-mapping | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| buffer@6.0.3 | node_modules/buffer | transitive | MIT | installed-package | PERMISSIVE |
| c12@3.1.0 | node_modules/c12 | transitive | MIT | installed-package | PERMISSIVE |
| caniuse-lite@1.0.30001764 | node_modules/caniuse-lite | transitive | CC-BY-4.0 | installed-package | PERMISSIVE |
| ccount@2.0.1 | node_modules/ccount | transitive | MIT | installed-package | PERMISSIVE |
| character-entities@2.0.2 | node_modules/character-entities | transitive | MIT | installed-package | PERMISSIVE |
| character-entities-html4@2.1.0 | node_modules/character-entities-html4 | transitive | MIT | installed-package | PERMISSIVE |
| character-entities-legacy@3.0.0 | node_modules/character-entities-legacy | transitive | MIT | installed-package | PERMISSIVE |
| character-reference-invalid@2.0.1 | node_modules/character-reference-invalid | transitive | MIT | installed-package | PERMISSIVE |
| chokidar@4.0.3 | node_modules/chokidar | transitive | MIT | installed-package | PERMISSIVE |
| citty@0.1.6 | node_modules/citty | transitive | MIT | installed-package | PERMISSIVE |
| class-variance-authority@0.7.1 | node_modules/class-variance-authority | direct | Apache-2.0 | installed-package | PERMISSIVE |
| classnames@2.5.1 | node_modules/classnames | transitive | MIT | installed-package | PERMISSIVE |
| clean-set@1.1.2 | node_modules/clean-set | transitive | MIT | installed-package | PERMISSIVE |
| client-only@0.0.1 | node_modules/client-only | transitive | MIT | installed-package | PERMISSIVE |
| clsx@2.1.1 | node_modules/clsx | direct | MIT | installed-package | PERMISSIVE |
| cm6-theme-basic-light@0.2.0 | node_modules/cm6-theme-basic-light | transitive | MIT | installed-package | PERMISSIVE |
| cmdk@1.1.1 | node_modules/cmdk | direct | MIT | installed-package | PERMISSIVE |
| codemirror@6.0.2 | node_modules/codemirror | transitive | MIT | installed-package | PERMISSIVE |
| comma-separated-tokens@2.0.3 | node_modules/comma-separated-tokens | transitive | MIT | installed-package | PERMISSIVE |
| compute-scroll-into-view@2.0.4 | node_modules/compute-scroll-into-view | transitive | MIT | installed-package | PERMISSIVE |
| confbox@0.2.2 | node_modules/confbox | transitive | MIT | installed-package | PERMISSIVE |
| consola@3.4.2 | node_modules/consola | transitive | MIT | installed-package | PERMISSIVE |
| cookie@0.7.2 | node_modules/cookie | transitive | MIT | installed-package | PERMISSIVE |
| crelt@1.0.6 | node_modules/crelt | transitive | MIT | installed-package | PERMISSIVE |
| csstype@3.2.3 | node_modules/csstype | transitive | MIT | installed-package | PERMISSIVE |
| d@1.0.2 | node_modules/d | transitive | ISC | installed-package | PERMISSIVE |
| d3-array@3.2.4 | node_modules/d3-array | transitive | ISC | installed-package | PERMISSIVE |
| d3-color@3.1.0 | node_modules/d3-color | transitive | ISC | installed-package | PERMISSIVE |
| d3-ease@3.0.1 | node_modules/d3-ease | transitive | BSD-3-Clause | installed-package | PERMISSIVE |
| d3-format@3.1.2 | node_modules/d3-format | transitive | ISC | installed-package | PERMISSIVE |
| d3-interpolate@3.0.1 | node_modules/d3-interpolate | transitive | ISC | installed-package | PERMISSIVE |
| d3-path@3.1.0 | node_modules/d3-path | transitive | ISC | installed-package | PERMISSIVE |
| d3-scale@4.0.2 | node_modules/d3-scale | transitive | ISC | installed-package | PERMISSIVE |
| d3-shape@3.2.0 | node_modules/d3-shape | transitive | ISC | installed-package | PERMISSIVE |
| d3-time@3.1.0 | node_modules/d3-time | transitive | ISC | installed-package | PERMISSIVE |
| d3-time-format@4.1.0 | node_modules/d3-time-format | transitive | ISC | installed-package | PERMISSIVE |
| d3-timer@3.0.1 | node_modules/d3-timer | transitive | ISC | installed-package | PERMISSIVE |
| date-fns@4.1.0 | node_modules/date-fns | direct | MIT | installed-package | PERMISSIVE |
| date-fns-jalali@4.1.0-0 | node_modules/date-fns-jalali | transitive | MIT | installed-package | PERMISSIVE |
| debug@4.4.3 | node_modules/debug | transitive | MIT | installed-package | PERMISSIVE |
| decimal.js-light@2.5.1 | node_modules/decimal.js-light | transitive | MIT | installed-package | PERMISSIVE |
| decode-named-character-reference@1.2.0 | node_modules/decode-named-character-reference | transitive | MIT | installed-package | PERMISSIVE |
| deepmerge-ts@7.1.5 | node_modules/deepmerge-ts | transitive | BSD-3-Clause | installed-package | PERMISSIVE |
| defu@6.1.4 | node_modules/defu | transitive | MIT | installed-package | PERMISSIVE |
| dequal@2.0.3 | node_modules/dequal | transitive | MIT | installed-package | PERMISSIVE |
| destr@2.0.5 | node_modules/destr | transitive | MIT | installed-package | PERMISSIVE |
| detect-libc@2.1.2 | node_modules/detect-libc | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| detect-node-es@1.1.0 | node_modules/detect-node-es | transitive | MIT | installed-package | PERMISSIVE |
| devlop@1.1.0 | node_modules/devlop | transitive | MIT | installed-package | PERMISSIVE |
| diff@5.2.0 | node_modules/diff | transitive | BSD-3-Clause | installed-package | PERMISSIVE |
| dom-helpers@5.2.1 | node_modules/dom-helpers | transitive | MIT | installed-package | PERMISSIVE |
| dotenv@16.6.1 | node_modules/dotenv | transitive | BSD-2-Clause | installed-package | PERMISSIVE |
| downshift@7.6.2 | node_modules/downshift | transitive | MIT | installed-package | PERMISSIVE |
| react-is@17.0.2 | node_modules/downshift/node_modules/react-is | transitive | MIT | npm-registry | PERMISSIVE |
| effect@3.18.4 | node_modules/effect | transitive | MIT | installed-package | PERMISSIVE |
| embla-carousel@8.6.0 | node_modules/embla-carousel | transitive | MIT | installed-package | PERMISSIVE |
| embla-carousel-react@8.6.0 | node_modules/embla-carousel-react | direct | MIT | installed-package | PERMISSIVE |
| embla-carousel-reactive-utils@8.6.0 | node_modules/embla-carousel-reactive-utils | transitive | MIT | installed-package | PERMISSIVE |
| empathic@2.0.0 | node_modules/empathic | transitive | MIT | installed-package | PERMISSIVE |
| es5-ext@0.10.64 | node_modules/es5-ext | transitive | ISC | installed-package | PERMISSIVE |
| es6-iterator@2.0.3 | node_modules/es6-iterator | transitive | MIT | installed-package | PERMISSIVE |
| es6-symbol@3.1.4 | node_modules/es6-symbol | transitive | ISC | installed-package | PERMISSIVE |
| escape-carriage@1.3.1 | node_modules/escape-carriage | transitive | MIT | installed-package | PERMISSIVE |
| esniff@2.0.1 | node_modules/esniff | transitive | ISC | installed-package | PERMISSIVE |
| estree-util-is-identifier-name@3.0.0 | node_modules/estree-util-is-identifier-name | transitive | MIT | installed-package | PERMISSIVE |
| estree-util-visit@2.0.0 | node_modules/estree-util-visit | transitive | MIT | installed-package | PERMISSIVE |
| event-emitter@0.3.5 | node_modules/event-emitter | transitive | MIT | installed-package | PERMISSIVE |
| eventemitter3@4.0.7 | node_modules/eventemitter3 | transitive | MIT | installed-package | PERMISSIVE |
| exsolve@1.0.8 | node_modules/exsolve | transitive | MIT | installed-package | PERMISSIVE |
| ext@1.7.0 | node_modules/ext | transitive | ISC | installed-package | PERMISSIVE |
| extend@3.0.2 | node_modules/extend | transitive | MIT | installed-package | PERMISSIVE |
| fast-check@3.23.2 | node_modules/fast-check | transitive | MIT | installed-package | PERMISSIVE |
| fast-equals@5.4.0 | node_modules/fast-equals | transitive | MIT | installed-package | PERMISSIVE |
| fault@2.0.1 | node_modules/fault | transitive | MIT | installed-package | PERMISSIVE |
| format@0.2.2 | node_modules/format | transitive | MIT (declared in package README; package.json omits the field) | installed-package | PERMISSIVE |
| framer-motion@12.26.2 | node_modules/framer-motion | direct | MIT | installed-package | PERMISSIVE |
| get-nonce@1.0.1 | node_modules/get-nonce | transitive | MIT | installed-package | PERMISSIVE |
| giget@2.0.0 | node_modules/giget | transitive | MIT | installed-package | PERMISSIVE |
| hast-util-parse-selector@2.2.5 | node_modules/hast-util-parse-selector | transitive | MIT | installed-package | PERMISSIVE |
| hast-util-to-jsx-runtime@2.3.6 | node_modules/hast-util-to-jsx-runtime | transitive | MIT | installed-package | PERMISSIVE |
| hast-util-whitespace@3.0.0 | node_modules/hast-util-whitespace | transitive | MIT | installed-package | PERMISSIVE |
| hastscript@6.0.0 | node_modules/hastscript | transitive | MIT | installed-package | PERMISSIVE |
| @types/hast@2.3.10 | node_modules/hastscript/node_modules/@types/hast | transitive | MIT | npm-registry | PERMISSIVE |
| @types/unist@2.0.11 | node_modules/hastscript/node_modules/@types/hast/node_modules/@types/unist | transitive | MIT | npm-registry | PERMISSIVE |
| comma-separated-tokens@1.0.8 | node_modules/hastscript/node_modules/comma-separated-tokens | transitive | MIT | npm-registry | PERMISSIVE |
| property-information@5.6.0 | node_modules/hastscript/node_modules/property-information | transitive | MIT | npm-registry | PERMISSIVE |
| space-separated-tokens@1.1.5 | node_modules/hastscript/node_modules/space-separated-tokens | transitive | MIT | npm-registry | PERMISSIVE |
| highlight.js@10.7.3 | node_modules/highlight.js | transitive | BSD-3-Clause | installed-package | PERMISSIVE |
| highlightjs-vue@1.0.0 | node_modules/highlightjs-vue | transitive | CC0-1.0 | installed-package | PERMISSIVE |
| html-url-attributes@3.0.1 | node_modules/html-url-attributes | transitive | MIT | installed-package | PERMISSIVE |
| icu-minify@4.15.3 | node_modules/icu-minify | transitive | MIT | installed-package | PERMISSIVE |
| ieee754@1.2.1 | node_modules/ieee754 | transitive | BSD-3-Clause | installed-package | PERMISSIVE |
| inline-style-parser@0.2.7 | node_modules/inline-style-parser | transitive | MIT | installed-package | PERMISSIVE |
| input-otp@1.4.2 | node_modules/input-otp | direct | MIT | installed-package | PERMISSIVE |
| internmap@2.0.3 | node_modules/internmap | transitive | ISC | installed-package | PERMISSIVE |
| intersection-observer@0.10.0 | node_modules/intersection-observer | transitive | W3C-20150513 | installed-package | NON-STANDARD |
| intl-messageformat@12.2.1 | node_modules/intl-messageformat | transitive | BSD-3-Clause | installed-package | PERMISSIVE |
| @formatjs/fast-memoize@3.1.8 | node_modules/intl-messageformat/node_modules/@formatjs/fast-memoize | transitive | MIT | npm-registry | PERMISSIVE |
| is-alphabetical@2.0.1 | node_modules/is-alphabetical | transitive | MIT | installed-package | PERMISSIVE |
| is-alphanumerical@2.0.1 | node_modules/is-alphanumerical | transitive | MIT | installed-package | PERMISSIVE |
| is-decimal@2.0.1 | node_modules/is-decimal | transitive | MIT | installed-package | PERMISSIVE |
| is-extglob@2.1.1 | node_modules/is-extglob | transitive | MIT | installed-package | PERMISSIVE |
| is-glob@4.0.3 | node_modules/is-glob | transitive | MIT | installed-package | PERMISSIVE |
| is-hexadecimal@2.0.1 | node_modules/is-hexadecimal | transitive | MIT | installed-package | PERMISSIVE |
| is-plain-obj@4.1.0 | node_modules/is-plain-obj | transitive | MIT | installed-package | PERMISSIVE |
| isomorphic.js@0.2.5 | node_modules/isomorphic.js | transitive | MIT | installed-package | PERMISSIVE |
| jiti@2.6.1 | node_modules/jiti | transitive | MIT | installed-package | PERMISSIVE |
| jose@4.15.9 | node_modules/jose | transitive | MIT | installed-package | PERMISSIVE |
| js-cookie@3.0.5 | node_modules/js-cookie | transitive | MIT | installed-package | PERMISSIVE |
| js-tokens@4.0.0 | node_modules/js-tokens | transitive | MIT | installed-package | PERMISSIVE |
| js-yaml@4.1.1 | node_modules/js-yaml | transitive | MIT | installed-package | PERMISSIVE |
| kleur@4.1.5 | node_modules/kleur | transitive | MIT | installed-package | PERMISSIVE |
| lexical@0.35.0 | node_modules/lexical | transitive | MIT | installed-package | PERMISSIVE |
| lib0@0.2.120 | node_modules/lib0 | transitive | MIT | installed-package | PERMISSIVE |
| lodash@4.17.21 | node_modules/lodash | transitive | MIT | installed-package | PERMISSIVE |
| lodash-es@4.17.22 | node_modules/lodash-es | transitive | MIT | installed-package | PERMISSIVE |
| longest-streak@3.1.0 | node_modules/longest-streak | transitive | MIT | installed-package | PERMISSIVE |
| loose-envify@1.4.0 | node_modules/loose-envify | transitive | MIT | installed-package | PERMISSIVE |
| lowlight@1.20.0 | node_modules/lowlight | transitive | MIT | installed-package | PERMISSIVE |
| fault@1.0.4 | node_modules/lowlight/node_modules/fault | transitive | MIT | npm-registry | PERMISSIVE |
| lru-cache@6.0.0 | node_modules/lru-cache | transitive | ISC | installed-package | PERMISSIVE |
| lucide-react@0.525.0 | node_modules/lucide-react | direct | ISC | installed-package | PERMISSIVE |
| lz-string@1.5.0 | node_modules/lz-string | transitive | MIT | installed-package | PERMISSIVE |
| markdown-table@3.0.4 | node_modules/markdown-table | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-directive@3.1.0 | node_modules/mdast-util-directive | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-from-markdown@2.0.2 | node_modules/mdast-util-from-markdown | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-frontmatter@2.0.1 | node_modules/mdast-util-frontmatter | transitive | MIT | installed-package | PERMISSIVE |
| escape-string-regexp@5.0.0 | node_modules/mdast-util-frontmatter/node_modules/escape-string-regexp | transitive | MIT | npm-registry | PERMISSIVE |
| mdast-util-gfm-strikethrough@2.0.0 | node_modules/mdast-util-gfm-strikethrough | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-gfm-table@2.0.0 | node_modules/mdast-util-gfm-table | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-gfm-task-list-item@2.0.0 | node_modules/mdast-util-gfm-task-list-item | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-highlight-mark@1.2.2 | node_modules/mdast-util-highlight-mark | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-mdx@3.0.0 | node_modules/mdast-util-mdx | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-mdx-expression@2.0.1 | node_modules/mdast-util-mdx-expression | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-mdx-jsx@3.2.0 | node_modules/mdast-util-mdx-jsx | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-mdxjs-esm@2.0.1 | node_modules/mdast-util-mdxjs-esm | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-phrasing@4.1.0 | node_modules/mdast-util-phrasing | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-to-hast@13.2.1 | node_modules/mdast-util-to-hast | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-to-markdown@2.1.2 | node_modules/mdast-util-to-markdown | transitive | MIT | installed-package | PERMISSIVE |
| mdast-util-to-string@4.0.0 | node_modules/mdast-util-to-string | transitive | MIT | installed-package | PERMISSIVE |
| micromark@4.0.2 | node_modules/micromark | transitive | MIT | installed-package | PERMISSIVE |
| micromark-core-commonmark@2.0.3 | node_modules/micromark-core-commonmark | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-directive@3.0.2 | node_modules/micromark-extension-directive | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-frontmatter@2.0.0 | node_modules/micromark-extension-frontmatter | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-gfm-strikethrough@2.1.0 | node_modules/micromark-extension-gfm-strikethrough | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-gfm-table@2.1.1 | node_modules/micromark-extension-gfm-table | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-gfm-task-list-item@2.1.0 | node_modules/micromark-extension-gfm-task-list-item | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-highlight-mark@1.2.0 | node_modules/micromark-extension-highlight-mark | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-mdx-expression@3.0.1 | node_modules/micromark-extension-mdx-expression | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-mdx-jsx@3.0.2 | node_modules/micromark-extension-mdx-jsx | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-mdx-md@2.0.0 | node_modules/micromark-extension-mdx-md | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-mdxjs@3.0.0 | node_modules/micromark-extension-mdxjs | transitive | MIT | installed-package | PERMISSIVE |
| micromark-extension-mdxjs-esm@3.0.0 | node_modules/micromark-extension-mdxjs-esm | transitive | MIT | installed-package | PERMISSIVE |
| micromark-factory-destination@2.0.1 | node_modules/micromark-factory-destination | transitive | MIT | installed-package | PERMISSIVE |
| micromark-factory-label@2.0.1 | node_modules/micromark-factory-label | transitive | MIT | installed-package | PERMISSIVE |
| micromark-factory-mdx-expression@2.0.3 | node_modules/micromark-factory-mdx-expression | transitive | MIT | installed-package | PERMISSIVE |
| micromark-factory-space@2.0.1 | node_modules/micromark-factory-space | transitive | MIT | installed-package | PERMISSIVE |
| micromark-factory-title@2.0.1 | node_modules/micromark-factory-title | transitive | MIT | installed-package | PERMISSIVE |
| micromark-factory-whitespace@2.0.1 | node_modules/micromark-factory-whitespace | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-character@2.1.1 | node_modules/micromark-util-character | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-chunked@2.0.1 | node_modules/micromark-util-chunked | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-classify-character@2.0.1 | node_modules/micromark-util-classify-character | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-combine-extensions@2.0.1 | node_modules/micromark-util-combine-extensions | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-decode-numeric-character-reference@2.0.2 | node_modules/micromark-util-decode-numeric-character-reference | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-decode-string@2.0.1 | node_modules/micromark-util-decode-string | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-encode@2.0.1 | node_modules/micromark-util-encode | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-events-to-acorn@2.0.3 | node_modules/micromark-util-events-to-acorn | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-html-tag-name@2.0.1 | node_modules/micromark-util-html-tag-name | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-normalize-identifier@2.0.1 | node_modules/micromark-util-normalize-identifier | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-resolve-all@2.0.1 | node_modules/micromark-util-resolve-all | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-sanitize-uri@2.0.1 | node_modules/micromark-util-sanitize-uri | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-subtokenize@2.1.0 | node_modules/micromark-util-subtokenize | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-symbol@2.0.1 | node_modules/micromark-util-symbol | transitive | MIT | installed-package | PERMISSIVE |
| micromark-util-types@2.0.2 | node_modules/micromark-util-types | transitive | MIT | installed-package | PERMISSIVE |
| mime-db@1.54.0 | node_modules/mime-db | transitive | MIT | installed-package | PERMISSIVE |
| motion-dom@12.26.2 | node_modules/motion-dom | transitive | MIT | installed-package | PERMISSIVE |
| motion-utils@12.24.10 | node_modules/motion-utils | transitive | MIT | installed-package | PERMISSIVE |
| mri@1.2.0 | node_modules/mri | transitive | MIT | installed-package | PERMISSIVE |
| ms@2.1.3 | node_modules/ms | transitive | MIT | installed-package | PERMISSIVE |
| nanoid@3.3.20 | node_modules/nanoid | transitive | MIT | installed-package | PERMISSIVE |
| negotiator@1.0.0 | node_modules/negotiator | transitive | MIT | installed-package | PERMISSIVE |
| next@16.4.6 | node_modules/next | direct | MIT | installed-package | PERMISSIVE |
| next-auth@4.24.15 | node_modules/next-auth | direct | ISC | installed-package | PERMISSIVE |
| next-intl@4.16.2 | node_modules/next-intl | direct | MIT | installed-package | PERMISSIVE |
| next-intl-swc-plugin-extractor@4.15.1 | node_modules/next-intl-swc-plugin-extractor | transitive | MIT | installed-package | PERMISSIVE |
| next-themes@0.4.6 | node_modules/next-themes | direct | MIT | installed-package | PERMISSIVE |
| next-tick@1.1.0 | node_modules/next-tick | transitive | ISC | installed-package | PERMISSIVE |
| node-addon-api@7.1.1 | node_modules/node-addon-api | transitive | MIT | installed-package | PERMISSIVE |
| node-fetch-native@1.6.7 | node_modules/node-fetch-native | transitive | MIT | installed-package | PERMISSIVE |
| nodemailer@10.6.1 | node_modules/nodemailer | direct | MIT-0 | installed-package | PERMISSIVE |
| nypm@0.6.2 | node_modules/nypm | transitive | MIT | installed-package | PERMISSIVE |
| oauth@0.9.15 | node_modules/oauth | transitive | MIT | installed-package | PERMISSIVE |
| object-assign@4.1.1 | node_modules/object-assign | transitive | MIT | installed-package | PERMISSIVE |
| object-hash@2.2.0 | node_modules/object-hash | transitive | MIT | installed-package | PERMISSIVE |
| ohash@2.0.11 | node_modules/ohash | transitive | MIT | installed-package | PERMISSIVE |
| oidc-token-hash@5.2.0 | node_modules/oidc-token-hash | transitive | MIT | installed-package | PERMISSIVE |
| openid-client@5.7.1 | node_modules/openid-client | transitive | MIT | installed-package | PERMISSIVE |
| outvariant@1.4.0 | node_modules/outvariant | transitive | MIT | installed-package | PERMISSIVE |
| parse-entities@4.0.2 | node_modules/parse-entities | transitive | MIT | installed-package | PERMISSIVE |
| @types/unist@2.0.11 | node_modules/parse-entities/node_modules/@types/unist | transitive | MIT | npm-registry | PERMISSIVE |
| pathe@2.0.3 | node_modules/pathe | transitive | MIT | installed-package | PERMISSIVE |
| perfect-debounce@1.0.0 | node_modules/perfect-debounce | transitive | MIT | installed-package | PERMISSIVE |
| picocolors@1.1.1 | node_modules/picocolors | transitive | ISC | installed-package | PERMISSIVE |
| picomatch@4.0.7 | node_modules/picomatch | transitive | MIT | installed-package | PERMISSIVE |
| pkg-types@2.3.0 | node_modules/pkg-types | transitive | MIT | installed-package | PERMISSIVE |
| po-parser@2.2.0 | node_modules/po-parser | transitive | MIT | installed-package | PERMISSIVE |
| postcss@8.5.23 | node_modules/postcss | transitive | MIT | installed-package | PERMISSIVE |
| preact@10.28.2 | node_modules/preact | transitive | MIT | installed-package | PERMISSIVE |
| preact-render-to-string@5.2.6 | node_modules/preact-render-to-string | transitive | MIT | installed-package | PERMISSIVE |
| pretty-format@3.8.0 | node_modules/pretty-format | transitive | MIT | installed-package | PERMISSIVE |
| prisma@6.19.2 | node_modules/prisma | direct | Apache-2.0 | installed-package | PERMISSIVE |
| prismjs@1.30.0 | node_modules/prismjs | transitive | MIT | installed-package | PERMISSIVE |
| prop-types@15.8.1 | node_modules/prop-types | transitive | MIT | installed-package | PERMISSIVE |
| react-is@16.13.1 | node_modules/prop-types/node_modules/react-is | transitive | MIT | npm-registry | PERMISSIVE |
| property-information@7.1.0 | node_modules/property-information | transitive | MIT | installed-package | PERMISSIVE |
| pure-rand@6.1.0 | node_modules/pure-rand | transitive | MIT | installed-package | PERMISSIVE |
| rc9@2.1.2 | node_modules/rc9 | transitive | MIT | installed-package | PERMISSIVE |
| react@19.2.3 | node_modules/react | direct | MIT | installed-package | PERMISSIVE |
| react-day-picker@9.13.0 | node_modules/react-day-picker | direct | MIT | installed-package | PERMISSIVE |
| react-devtools-inline@4.4.0 | node_modules/react-devtools-inline | transitive | MIT | installed-package | PERMISSIVE |
| react-dom@19.2.3 | node_modules/react-dom | direct | MIT | installed-package | PERMISSIVE |
| react-error-boundary@3.1.4 | node_modules/react-error-boundary | transitive | MIT | installed-package | PERMISSIVE |
| react-hook-form@7.71.1 | node_modules/react-hook-form | direct | MIT | installed-package | PERMISSIVE |
| react-is@18.3.1 | node_modules/react-is | transitive | MIT | installed-package | PERMISSIVE |
| react-markdown@10.1.0 | node_modules/react-markdown | direct | MIT | installed-package | PERMISSIVE |
| react-remove-scroll@2.7.2 | node_modules/react-remove-scroll | transitive | MIT | installed-package | PERMISSIVE |
| react-remove-scroll-bar@2.3.8 | node_modules/react-remove-scroll-bar | transitive | MIT | installed-package | PERMISSIVE |
| react-resizable-panels@3.0.6 | node_modules/react-resizable-panels | direct | MIT | installed-package | PERMISSIVE |
| react-smooth@4.0.4 | node_modules/react-smooth | transitive | MIT | installed-package | PERMISSIVE |
| react-style-singleton@2.2.3 | node_modules/react-style-singleton | transitive | MIT | installed-package | PERMISSIVE |
| react-syntax-highlighter@15.6.6 | node_modules/react-syntax-highlighter | direct | MIT | installed-package | PERMISSIVE |
| react-transition-group@4.4.5 | node_modules/react-transition-group | transitive | BSD-3-Clause | installed-package | PERMISSIVE |
| readdirp@4.1.2 | node_modules/readdirp | transitive | MIT | installed-package | PERMISSIVE |
| recharts@2.15.4 | node_modules/recharts | direct | MIT | installed-package | PERMISSIVE |
| recharts-scale@0.4.5 | node_modules/recharts-scale | transitive | MIT | installed-package | PERMISSIVE |
| refractor@3.6.0 | node_modules/refractor | transitive | MIT | installed-package | PERMISSIVE |
| parse-entities@2.0.0 | node_modules/refractor/node_modules/parse-entities | transitive | MIT | npm-registry | PERMISSIVE |
| character-entities@1.2.4 | node_modules/refractor/node_modules/parse-entities/node_modules/character-entities | transitive | MIT | npm-registry | PERMISSIVE |
| character-entities-legacy@1.1.4 | node_modules/refractor/node_modules/parse-entities/node_modules/character-entities-legacy | transitive | MIT | npm-registry | PERMISSIVE |
| character-reference-invalid@1.1.4 | node_modules/refractor/node_modules/parse-entities/node_modules/character-reference-invalid | transitive | MIT | npm-registry | PERMISSIVE |
| is-alphanumerical@1.0.4 | node_modules/refractor/node_modules/parse-entities/node_modules/is-alphanumerical | transitive | MIT | npm-registry | PERMISSIVE |
| is-alphabetical@1.0.4 | node_modules/refractor/node_modules/parse-entities/node_modules/is-alphanumerical/node_modules/is-alphabetical | transitive | MIT | npm-registry | PERMISSIVE |
| is-decimal@1.0.4 | node_modules/refractor/node_modules/parse-entities/node_modules/is-decimal | transitive | MIT | npm-registry | PERMISSIVE |
| is-hexadecimal@1.0.4 | node_modules/refractor/node_modules/parse-entities/node_modules/is-hexadecimal | transitive | MIT | npm-registry | PERMISSIVE |
| prismjs@1.27.0 | node_modules/refractor/node_modules/prismjs | transitive | MIT | npm-registry | PERMISSIVE |
| remark-parse@11.0.0 | node_modules/remark-parse | transitive | MIT | installed-package | PERMISSIVE |
| remark-rehype@11.1.2 | node_modules/remark-rehype | transitive | MIT | installed-package | PERMISSIVE |
| sade@1.8.1 | node_modules/sade | transitive | MIT | installed-package | PERMISSIVE |
| scheduler@0.27.0 | node_modules/scheduler | transitive | MIT | installed-package | PERMISSIVE |
| screenfull@5.2.0 | node_modules/screenfull | transitive | MIT | installed-package | PERMISSIVE |
| semver@7.8.6 | node_modules/semver | transitive | ISC | installed-package | PERMISSIVE |
| sharp@0.35.5 | node_modules/sharp | direct | Apache-2.0 | installed-package | PERMISSIVE |
| sonner@2.0.7 | node_modules/sonner | direct | MIT | installed-package | PERMISSIVE |
| source-map-js@1.2.1 | node_modules/source-map-js | transitive | BSD-3-Clause | installed-package | PERMISSIVE |
| space-separated-tokens@2.0.2 | node_modules/space-separated-tokens | transitive | MIT | installed-package | PERMISSIVE |
| static-browser-server@1.0.3 | node_modules/static-browser-server | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| strict-event-emitter@0.4.6 | node_modules/strict-event-emitter | transitive | MIT | installed-package | PERMISSIVE |
| stringify-entities@4.0.4 | node_modules/stringify-entities | transitive | MIT | installed-package | PERMISSIVE |
| style-mod@4.1.3 | node_modules/style-mod | transitive | MIT | installed-package | PERMISSIVE |
| style-to-js@1.1.21 | node_modules/style-to-js | transitive | MIT | installed-package | PERMISSIVE |
| style-to-object@1.0.14 | node_modules/style-to-object | transitive | MIT | installed-package | PERMISSIVE |
| styled-jsx@5.1.6 | node_modules/styled-jsx | transitive | MIT | installed-package | PERMISSIVE |
| tabbable@6.4.0 | node_modules/tabbable | transitive | MIT | installed-package | PERMISSIVE |
| tailwind-merge@3.4.0 | node_modules/tailwind-merge | direct | MIT | installed-package | PERMISSIVE |
| tailwindcss@4.1.18 | node_modules/tailwindcss | transitive | MIT | installed-package | PERMISSIVE |
| tailwindcss-animate@1.0.7 | node_modules/tailwindcss-animate | direct | MIT | installed-package | PERMISSIVE |
| tiny-invariant@1.3.3 | node_modules/tiny-invariant | transitive | MIT | installed-package | PERMISSIVE |
| tinyexec@1.0.2 | node_modules/tinyexec | transitive | MIT | installed-package | PERMISSIVE |
| trim-lines@3.0.1 | node_modules/trim-lines | transitive | MIT | installed-package | PERMISSIVE |
| trough@2.2.0 | node_modules/trough | transitive | MIT | installed-package | PERMISSIVE |
| tslib@2.8.1 | node_modules/tslib | transitive | 0BSD | installed-package | PERMISSIVE |
| type@2.7.3 | node_modules/type | transitive | ISC | installed-package | PERMISSIVE |
| typescript@5.9.3 | node_modules/typescript | transitive | Apache-2.0 | installed-package | PERMISSIVE |
| unidiff@1.0.4 | node_modules/unidiff | transitive | MIT | installed-package | PERMISSIVE |
| unified@11.0.5 | node_modules/unified | transitive | MIT | installed-package | PERMISSIVE |
| unist-util-is@6.0.1 | node_modules/unist-util-is | transitive | MIT | installed-package | PERMISSIVE |
| unist-util-position@5.0.0 | node_modules/unist-util-position | transitive | MIT | installed-package | PERMISSIVE |
| unist-util-position-from-estree@2.0.0 | node_modules/unist-util-position-from-estree | transitive | MIT | installed-package | PERMISSIVE |
| unist-util-stringify-position@4.0.0 | node_modules/unist-util-stringify-position | transitive | MIT | installed-package | PERMISSIVE |
| unist-util-visit@5.0.0 | node_modules/unist-util-visit | transitive | MIT | installed-package | PERMISSIVE |
| unist-util-visit-parents@6.0.2 | node_modules/unist-util-visit-parents | transitive | MIT | installed-package | PERMISSIVE |
| use-callback-ref@1.3.3 | node_modules/use-callback-ref | transitive | MIT | installed-package | PERMISSIVE |
| use-intl@4.15.1 | node_modules/use-intl | transitive | MIT | installed-package | PERMISSIVE |
| use-sidecar@1.1.3 | node_modules/use-sidecar | transitive | MIT | installed-package | PERMISSIVE |
| use-sync-external-store@1.6.0 | node_modules/use-sync-external-store | transitive | MIT | installed-package | PERMISSIVE |
| uuid@11.1.1 | node_modules/uuid | direct | MIT | installed-package | PERMISSIVE |
| uvu@0.5.6 | node_modules/uvu | transitive | MIT | installed-package | PERMISSIVE |
| vaul@1.1.2 | node_modules/vaul | direct | MIT | installed-package | PERMISSIVE |
| vfile@6.0.3 | node_modules/vfile | transitive | MIT | installed-package | PERMISSIVE |
| vfile-message@4.0.3 | node_modules/vfile-message | transitive | MIT | installed-package | PERMISSIVE |
| victory-vendor@36.9.2 | node_modules/victory-vendor | transitive | MIT AND ISC | installed-package | PERMISSIVE |
| w3c-keyname@2.2.8 | node_modules/w3c-keyname | transitive | MIT | installed-package | PERMISSIVE |
| xtend@4.0.2 | node_modules/xtend | transitive | MIT | installed-package | PERMISSIVE |
| yallist@4.0.0 | node_modules/yallist | transitive | ISC | installed-package | PERMISSIVE |
| yjs@13.6.33 | node_modules/yjs | transitive | MIT | installed-package | PERMISSIVE |
| z-ai-web-dev-sdk@0.0.18 | node_modules/z-ai-web-dev-sdk | direct | ISC | installed-package | PERMISSIVE |
| zod@4.6.7 | node_modules/zod | direct | MIT | installed-package | PERMISSIVE |
| zustand@5.0.10 | node_modules/zustand | direct | MIT | installed-package | PERMISSIVE |
| zwitch@2.0.4 | node_modules/zwitch | transitive | MIT | installed-package | PERMISSIVE |

## 2. Development-only instances (not shipped, enumerated for completeness)

424 instances — full list in `docs/legal/generated/dependency-audit.json` (`devPackages`) and the SBOM (scope `excluded`). Classification: PERMISSIVE=411, COPYLEFT-WEAK=13.

## 3. Adapted external code

- **shadcn/ui component primitives** — files under `src/components/ui/*` are adapted from shadcn/ui (MIT), built on Radix UI primitives (npm instances above).
- Small well-known community patterns are re-implemented in-repo; no verbatim third-party file is copied without attribution.

## 4. Optional integrations

- **z-ai gateway SDK** — environment-provided SDK for LLM/ASR/TTS when the deployment supplies it. Not a package of this lockfile; its terms are the provider's; excluded from redistribution claims. Absent → capabilities disclosed, never faked.
- **Local transcription engines** (e.g. faster-whisper) — registered NOT-ready unless explicitly enabled; licenses assessed before enabling. No silent engine downloads.

## 5. Reference-only projects

- Research repositories studied during milestones (`docs/OPEN_SOURCE_VIDEO_AI_RESEARCH.md`) are reference-only: no code copied, NOT integrated dependencies.

## 6. Open-source learning resources

- FFmpeg documentation, MDN Web Docs, WAI-ARIA Authoring Practices, Next.js/Prisma/Radix/CodeMirror docs — documentation, not dependencies.

## 7. AI coding assistant guidance

- Users may explore this public repository — and any public open-source repository — and use their preferred AI coding assistant (including Claude and other independent providers), subject to each provider's own terms.
- BEAN FX does **not** provide unlimited free AI assistant subscriptions. AI provider pricing is separate.
- Public source availability does not remove copyright. Repository licenses govern code reuse.
- AI-generated modifications do not remove upstream obligations (attribution, license texts, copyleft terms).
- Not every coding assistant is free — check each provider's terms.

## 8. Third-party licenses and notices

- Full license copies for direct production dependencies: `docs/legal/licenses/`.
- Required notices: `THIRD_PARTY_NOTICES.md` (repository root).
- SBOM (CycloneDX 1.5, one component per instance, unique bom-refs): `docs/legal/sbom.cdx.json`; machine-readable audit: `docs/legal/generated/dependency-audit.json`.
- Risk assessment: `docs/legal/LICENSE_RISK_REPORT.md`.
