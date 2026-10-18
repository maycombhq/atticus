import { basename, resolve } from "node:path";
import { flattenProperties, flattenYaml, parseJava } from "@maycombhq/extractors";
import { fsRepo, type RepoHandle } from "@maycombhq/sdk";

/**
 * A deterministic survey of a handful of repos built on one house framework: what files
 * they share (a descriptor is the usual marker), which annotations they use and how, and
 * which config keys they set. `dialect new` turns it into a scaffold; nothing here guesses
 * what an annotation means, which is the assistant's job.
 */

export type AnnotationTarget = "class" | "method" | "field";

export interface SurveyValue {
  repo: string;
  value: string;
}

export interface AnnotationSurvey {
  /** Simple name, as the engine matches it. */
  name: string;
  /** A well-known annotation (Java, Spring, JAX-RS, JPA, Lombok, JUnit...), not the house framework's. */
  known: boolean;
  targets: AnnotationTarget[];
  count: number;
  repos: string[];
  attributes: string[];
  /** House annotations on the type around a method or field use: candidates for ${annotation.X.attr}. */
  enclosing: string[];
  sample: { repo: string; path: string; line: number; text: string };
}

export interface RepoSurvey {
  repos: string[];
  /** Root-level descriptor-like files, with how many repos have each; most common first. */
  markerCandidates: { path: string; repos: number }[];
  /** The candidate every repo has, if any. */
  marker?: string;
  sourceRoots: string[];
  configFiles: string[];
  /** The marker's keys when it is YAML or JSON. */
  descriptor?: {
    file: string;
    /** A key that names the app or service in every repo, for ids and owners. */
    nameKey?: string;
    keys: { key: string; values: SurveyValue[] }[];
  };
  annotations: AnnotationSurvey[];
  configKeys: { key: string; values: SurveyValue[] }[];
}

const DESCRIPTOR_EXT = /\.(ya?ml|json|xml|properties|toml|conf)$/;

/** Root files every kind of repo has; never a framework marker. */
const BUILD_FILES = new Set([
  "pom.xml",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "gradle.properties",
  "lerna.json",
  "nx.json",
  "turbo.json",
  "renovate.json",
  "catalog-info.yaml",
  "mkdocs.yml",
  "codecov.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "sonar-project.properties",
  "lombok.config",
  "application.yml",
  "application.yaml",
  "application.properties",
]);

const SOURCE_ROOTS = ["src/main/java", "src/main/kotlin"];

const CONFIG_FILES = [
  "src/main/resources/application.yml",
  "src/main/resources/application.yaml",
  "src/main/resources/application.properties",
  "application.yml",
  "application.yaml",
  "application.properties",
];

/** Keys that usually name the app in a descriptor, in order of preference. */
const NAME_KEYS = ["app", "service", "name", "application", "component", "id"];

/** Annotations from the Java platform and common libraries: built-in extractors or not integration. */
const KNOWN_ANNOTATIONS = new Set(
  [
    // java.lang
    "Override Deprecated SuppressWarnings FunctionalInterface SafeVarargs Retention Target Documented Inherited",
    // Spring
    "Component Service Repository Controller RestController Configuration Bean Autowired Value Qualifier Primary Profile Lazy Scope",
    "RequestMapping GetMapping PostMapping PutMapping DeleteMapping PatchMapping PathVariable RequestBody RequestParam RequestHeader ResponseBody ResponseStatus ExceptionHandler ControllerAdvice CrossOrigin",
    "FeignClient KafkaListener KafkaHandler SendTo JmsListener RabbitListener EnableKafka EnableFeignClients Transactional Query Modifying Scheduled EnableScheduling Async EnableAsync",
    "SpringBootApplication EnableAutoConfiguration ComponentScan ConfigurationProperties ConditionalOnProperty Import Valid Validated",
    "CircuitBreaker Retry RateLimiter Bulkhead TimeLimiter",
    // JAX-RS
    "Path GET POST PUT DELETE PATCH HEAD OPTIONS Produces Consumes PathParam QueryParam HeaderParam FormParam Context",
    // JPA
    "Entity Table Id Column GeneratedValue ManyToOne OneToMany OneToOne ManyToMany JoinColumn Embedded Embeddable Enumerated Version Transient",
    // Lombok
    "Data Getter Setter Builder NoArgsConstructor AllArgsConstructor RequiredArgsConstructor Slf4j ToString EqualsAndHashCode",
    // Tests
    "Test BeforeEach AfterEach BeforeAll AfterAll ParameterizedTest DisplayName Mock InjectMocks Spy ExtendWith SpringBootTest MockBean",
    // Validation and JSON
    "NotNull NotBlank NotEmpty Size Min Max Pattern Email Nullable Nonnull JsonProperty JsonIgnore JsonInclude JsonCreator",
  ]
    .join(" ")
    .split(" "),
);

async function list(repo: RepoHandle, globs: string[]): Promise<string[]> {
  const out: string[] = [];
  for await (const p of repo.listFiles(globs)) out.push(p);
  return out;
}

const oneLine = (s: string, max = 80) => {
  const t = s.replace(/\s*\r?\n\s*/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

function flatten(path: string, text: string): Map<string, { value: string }> {
  if (path.endsWith(".properties")) return flattenProperties(text, path);
  if (/\.(ya?ml|json)$/.test(path)) return flattenYaml(text, path);
  return new Map();
}

function addValue(map: Map<string, SurveyValue[]>, key: string, v: SurveyValue) {
  const list = map.get(key) ?? [];
  list.push(v);
  map.set(key, list);
}

const byRepo = (a: SurveyValue, b: SurveyValue) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Survey repo folders (absolute or relative to the working folder). Order of input doesn't matter. */
export async function surveyRepos(dirs: string[]): Promise<RepoSurvey> {
  const repos = dirs
    .map((d) => {
      const dir = resolve(d);
      return fsRepo(basename(dir), dir, "0".repeat(40));
    })
    .sort((a, b) => cmp(a.name, b.name));
  const files = new Map<string, string[]>();
  for (const r of repos) files.set(r.name, await list(r, ["**/*"]));

  // Marker candidates: descriptor-like files at the root.
  const rootCount = new Map<string, number>();
  for (const r of repos)
    for (const f of files.get(r.name)!)
      if (!f.includes("/") && DESCRIPTOR_EXT.test(f) && !BUILD_FILES.has(f) && !f.startsWith("."))
        rootCount.set(f, (rootCount.get(f) ?? 0) + 1);
  const markerCandidates = [...rootCount]
    .map(([path, n]) => ({ path, repos: n }))
    .sort((a, b) => b.repos - a.repos || cmp(a.path, b.path));
  const marker = markerCandidates.find((c) => c.repos === repos.length)?.path;

  const anyHas = (pred: (f: string) => boolean) => repos.some((r) => files.get(r.name)!.some(pred));
  const sourceRoots = SOURCE_ROOTS.filter((root) => anyHas((f) => f.startsWith(`${root}/`)));
  const configFiles = CONFIG_FILES.filter((c) => anyHas((f) => f === c));

  let descriptor: RepoSurvey["descriptor"];
  if (marker && /\.(ya?ml|json|properties)$/.test(marker)) {
    const keys = new Map<string, SurveyValue[]>();
    for (const r of repos)
      for (const [k, v] of flatten(marker, await r.readText(marker)))
        addValue(keys, k, { repo: r.name, value: oneLine(v.value) });
    const keyList = [...keys]
      .sort(([a], [b]) => cmp(a, b))
      .map(([key, values]) => ({ key, values: values.sort(byRepo) }));
    const nameKey = NAME_KEYS.find((k) => keys.get(k)?.length === repos.length);
    descriptor = { file: marker, ...(nameKey ? { nameKey } : {}), keys: keyList };
  }

  // Annotations in source files (production code only when the layout is known).
  const javaGlobs =
    sourceRoots.length > 0
      ? sourceRoots.flatMap((s) => [`${s}/**/*.java`, `${s}/**/*.kt`])
      : ["**/*.java", "**/*.kt"];
  const found = new Map<
    string,
    {
      targets: Set<AnnotationTarget>;
      count: number;
      repos: Set<string>;
      attributes: Set<string>;
      enclosing: Set<string>;
      sample?: AnnotationSurvey["sample"];
    }
  >();
  for (const r of repos) {
    const sources = (await list(r, javaGlobs)).filter(
      (p) => sourceRoots.length > 0 || !/(^|\/)src\/test\//.test(p),
    );
    for (const path of sources) {
      const text = await r.readText(path);
      const lines = text.split(/\r?\n/);
      for (const d of parseJava(text).decls) {
        const target: AnnotationTarget =
          d.kind === "method" ? "method" : d.kind === "field" ? "field" : "class";
        const around = d.kind === "method" || d.kind === "field" ? d.parent : undefined;
        for (const a of d.annotations) {
          const e = found.get(a.name) ?? {
            targets: new Set(),
            count: 0,
            repos: new Set(),
            attributes: new Set(),
            enclosing: new Set(),
          };
          e.targets.add(target);
          e.count++;
          e.repos.add(r.name);
          for (const k of Object.keys(a.attrs)) e.attributes.add(k);
          for (const p of around?.annotations ?? [])
            if (!KNOWN_ANNOTATIONS.has(p.name)) e.enclosing.add(p.name);
          e.sample ??= {
            repo: r.name,
            path,
            line: a.line,
            text: oneLine(lines[a.line - 1] ?? `@${a.name}`, 160),
          };
          found.set(a.name, e);
        }
      }
    }
  }
  const order: AnnotationTarget[] = ["class", "method", "field"];
  const annotations: AnnotationSurvey[] = [...found]
    .sort(([a], [b]) => cmp(a, b))
    .map(([name, e]) => ({
      name,
      known: KNOWN_ANNOTATIONS.has(name),
      targets: order.filter((t) => e.targets.has(t)),
      count: e.count,
      repos: [...e.repos].sort(cmp),
      attributes: [...e.attributes].sort(cmp),
      enclosing: [...e.enclosing].sort(cmp),
      sample: e.sample!,
    }));

  // Config keys from the usual config files.
  const config = new Map<string, SurveyValue[]>();
  for (const r of repos)
    for (const c of configFiles)
      if (files.get(r.name)!.includes(c))
        for (const [k, v] of flatten(c, await r.readText(c)))
          if (!config.get(k)?.some((x) => x.repo === r.name))
            addValue(config, k, { repo: r.name, value: oneLine(v.value) });
  const configKeys = [...config]
    .sort(([a], [b]) => cmp(a, b))
    .map(([key, values]) => ({ key, values: values.sort(byRepo) }));

  return {
    repos: repos.map((r) => r.name),
    markerCandidates,
    ...(marker ? { marker } : {}),
    sourceRoots,
    configFiles,
    ...(descriptor ? { descriptor } : {}),
    annotations,
    configKeys,
  };
}
