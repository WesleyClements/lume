import { posix } from "../deps/path.ts";
import { getExtension, normalizePath } from "./utils/path.ts";
import { mergeData } from "./utils/merge_data.ts";
import { getBasename, getPageUrl } from "./utils/page_url.ts";
import { getPageDate } from "./utils/page_date.ts";
import { Page, StaticFile } from "./file.ts";

import type { Data, RawData } from "./file.ts";
import type { default as FS, Entry } from "./fs.ts";
import type { default as Formats, Format } from "./formats.ts";
import type DataLoader from "./data_loader.ts";
import type { ScopeFilter } from "./scopes.ts";
import type {
  Components,
  default as ComponentLoader,
} from "./component_loader.ts";

export interface Options {
  formats: Formats;
  dataLoader: DataLoader;
  componentLoader: ComponentLoader;
  scopedData: Map<string, RawData>;
  scopedPages: Map<string, RawData[]>;
  scopedComponents: Map<string, Components>;
  basenameParsers: BasenameParser[];
  fs: FS;
  prettyUrls: boolean;
  components: {
    cssFile: string;
    jsFile: string;
  };
}

/**
 * Scan and load files from the source folder
 * with the data, pages, assets and static files
 */
export default class Source {
  /** Filesystem reader to scan folders */
  fs: FS;

  /** To load all _data files */
  dataLoader: DataLoader;

  /** To load all components */
  componentLoader: ComponentLoader;

  /** Info about how to handle different file formats */
  formats: Formats;

  /** The list of paths to ignore */
  ignored = new Set<string>();

  /** The path filters to ignore */
  filters: ScopeFilter[] = [];

  /** The data assigned per path */
  scopedData: Map<string, RawData>;

  /** The pages assigned per path */
  scopedPages: Map<string, RawData[]>;

  /** The components assigned per path */
  scopedComponents: Map<string, Components>;

  /** Use pretty URLs */
  prettyUrls: boolean;

  /** Extra code generated by components */
  extraCode = new Map<string, Map<string, string>>();

  components: {
    /** File name used to output the extra CSS code generated by the components */
    cssFile: string;

    /** File name used to output the extra JavaScript code generated by the components */
    jsFile: string;
  };

  /** The data assigned per path */
  data = new Map<string, Partial<Data>>();

  /** Custom parsers for basenames */
  basenameParsers: BasenameParser[] = [];

  /** Files added with `site.add()` */
  addedFiles = new Map<string, string | Destination>();

  constructor(options: Options) {
    this.dataLoader = options.dataLoader;
    this.componentLoader = options.componentLoader;
    this.fs = options.fs;
    this.formats = options.formats;
    this.components = options.components;
    this.scopedData = options.scopedData;
    this.scopedPages = options.scopedPages;
    this.scopedComponents = options.scopedComponents;
    this.prettyUrls = options.prettyUrls;
    this.basenameParsers = options.basenameParsers;
  }

  addIgnoredPath(path: string) {
    this.ignored.add(normalizePath(path));
  }

  addIgnoreFilter(filter: ScopeFilter) {
    this.filters.push(filter);
  }

  addFile(from: string, to: string | Destination) {
    if (from.startsWith(".")) {
      if (typeof to !== "function") {
        throw new Error(
          `Added files by extensions like "${from}" expects a function to calculate the destination but got a string "${to}"`,
        );
      }
    } else {
      from = normalizePath(from);
    }

    if (typeof to === "string") {
      if (to.endsWith("/")) {
        to = to.slice(0, -1);
      }

      to = normalizePath(to);
    }

    this.addedFiles.set(from, to);
  }

  async build(...buildFilters: BuildFilter[]): Promise<[Page[], StaticFile[]]> {
    const pages: Page[] = [];
    const staticFiles: StaticFile[] = [];
    this.data.clear();

    await this.#addDirectory(
      buildFilters,
      this.fs.entries.get("/")!,
      "/",
      new Map(),
      {},
      pages,
      staticFiles,
    );

    return [
      pages,
      staticFiles,
    ];
  }

  /** Returns the pages with extra code generated by the components */
  getComponentsExtraCode(): [string, string][] {
    const files = {
      css: this.components.cssFile,
      js: this.components.jsFile,
    };

    const pages: [string, string][] = [];

    for (const [type, path] of Object.entries(files)) {
      const code = this.extraCode.get(type);

      if (code?.size) {
        const content = type === "css"
          ? Array.from(code.values()).sort(sortCSS).join("\n")
          : Array.from(code.values()).join("\n");

        pages.push([path, content]);
      }
    }

    return pages;
  }

  async #addDirectory(
    buildFilters: BuildFilter[],
    dir: Entry,
    parentPath: string,
    parentComponents: Components,
    parentData: Partial<Data>,
    pages: Page[],
    staticFiles: StaticFile[],
    destination?: Destination,
  ): Promise<void> {
    if (buildFilters.some((filter) => !filter(dir))) {
      return;
    }

    // Load _data
    const dirData = await this.#loadDirData(dir, parentData);
    let dirPath = posix.join(parentPath, dirData.basename!);

    // Load _components
    const dirComponents = await this.#loadDirComponents(
      dir,
      parentComponents,
      dirData,
    );

    // Create the components proxy only if new components were found
    if (dirComponents !== parentComponents) {
      dirData.comp = toProxy(
        dirComponents,
        this.extraCode,
      );
    }

    // Store the directory data to be used by other plugins
    this.data.set(dir.path, dirData);
    this.data.set(dirPath, dirData);

    // Load pages created with `site.page()`
    for await (const page of this.#getDirPages(dirPath, dirData)) {
      if (buildFilters.some((filter) => !filter(dir, page))) {
        continue;
      }
      pages.push(page);
    }

    // The folder is added with `site.add("folder")`
    const dest = this.addedFiles.get(dir.path) ||
      this.addedFiles.get(dirPath) ||
      this.addedFiles.get(`${dir.path}/`) ||
      this.addedFiles.get(`${dirPath}/`);

    if (dest) {
      if (typeof dest === "function") {
        const prev = destination;
        destination = prev ? (path: string) => dest(prev(path)) : dest;
      } else {
        dirPath = dest;
        destination ??= (path: string) => path;
      }
    }

    // Iterate over the directory entries
    for (const entry of dir.children.values()) {
      if (buildFilters.some((filter) => !filter(entry))) {
        continue;
      }

      if (entry.type === "file") {
        await this.#addFile(
          buildFilters,
          entry,
          dirPath,
          dirData,
          pages,
          staticFiles,
          destination,
        );

        continue;
      }

      if (entry.type === "directory") {
        if (this.#isIgnored(entry)) {
          // Add possible inner entries
          // For example: site.ignore("folder").add("folder/file.ext")
          for (const path of this.addedFiles.keys()) {
            if (!path.startsWith(entry.path) || path === entry.path) {
              continue;
            }

            const subEntry = this.fs.entries.get(path);

            if (!subEntry) {
              continue;
            }

            if (subEntry.type === "file") {
              await this.#addFile(
                buildFilters,
                subEntry,
                dirPath,
                dirData,
                pages,
                staticFiles,
                destination,
              );
              continue;
            }

            if (subEntry.type === "directory") {
              await this.#addDirectory(
                buildFilters,
                subEntry,
                dirPath,
                dirComponents,
                dirData,
                pages,
                staticFiles,
                destination,
              );
            }
          }

          continue;
        }

        await this.#addDirectory(
          buildFilters,
          entry,
          dirPath,
          dirComponents,
          dirData,
          pages,
          staticFiles,
          destination,
        );
      }
    }
  }

  async #addFile(
    buildFilters: BuildFilter[],
    file: Entry,
    dirPath: string,
    dirData: Partial<Data>,
    pages: Page[],
    staticFiles: StaticFile[],
    destination?: Destination,
  ) {
    // The file is added with `site.add("file.ext")`
    const destPath = this.addedFiles.get(file.path);

    // If the file must be ignored and not explicitly added
    if (!destPath && this.#isIgnored(file)) {
      return;
    }

    // Merge folder and file destinations
    let fileDestination: string | Destination | undefined;

    if (typeof destPath === "string") {
      fileDestination = destPath;
    } else if (typeof destPath === "function") {
      fileDestination = destination
        ? (path) => destPath(destination(path))
        : destPath;
    } else {
      fileDestination = destination;
    }

    const format = this.formats.search(file.path);

    // The format is a page `site.loadPages([".ext"])`
    if (format?.isPage) {
      const page = await this.#loadPage(
        file,
        format,
        dirData,
        dirPath,
        fileDestination,
      );

      if (
        page &&
        (!buildFilters.length ||
          buildFilters.every((filter) => filter(file, page)))
      ) {
        pages.push(page);
      }

      return;
    }

    const ext = format?.ext || getExtension(file.name);

    // The file is added explicitly with `site.add("file.ext")`
    if (destPath) {
      return staticFiles.push(
        createFile(file, ext, dirPath, dirData, fileDestination),
      );
    }

    // The file is added with `site.add([".ext"])`
    const extensionDest = this.addedFiles.get(ext);

    if (typeof extensionDest === "function") {
      const wrapper = fileDestination;

      // Merge destinations
      fileDestination = typeof wrapper === "function"
        ? (path: string) => wrapper(extensionDest(path))
        : extensionDest;
    }

    // If `fileDestination` exists is because:
    // - the file was added with `site.add([".ext"])`
    // - or any parent folder with `site.add("folder")`
    if (fileDestination) {
      return staticFiles.push(
        createFile(file, ext, dirPath, dirData, fileDestination),
      );
    }
  }

  /** Check if the entry must be ignored by Lume */
  #isIgnored(entry: Entry) {
    return (entry.name.startsWith(".") &&
      (entry.type !== "directory" || entry.path !== "/.well-known")) ||
      entry.name.startsWith("_") ||
      this.ignored.has(entry.path) ||
      this.filters.some((filter) => filter(entry.path));
  }

  /** Load a folder's _data and merge it with the parent data  */
  async #loadDirData(dir: Entry, parentData: RawData): Promise<Partial<Data>> {
    // Parse the directory's basename
    const { basename, ...parsedData } = runBasenameParsers(
      dir.name,
      this.basenameParsers,
    );

    // Load _data files
    const dirDatas: RawData[] = [];

    for (const entry of dir.children.values()) {
      if (
        (entry.type === "file" && entry.name.startsWith("_data.")) ||
        (entry.type === "directory" && entry.name === "_data")
      ) {
        const loaded = await this.dataLoader.load(entry);
        if (loaded) {
          dirDatas.push(loaded);
        }
      }
    }

    // Data registered from site.data()
    const scopedData = this.scopedData.get(dir.path) || {};

    // Merge directory data
    return mergeData(
      parentData,
      { basename },
      scopedData,
      parsedData,
      ...dirDatas,
    ) as Partial<Data>;
  }

  /**
   * Load _components, merge them with the parent components
   * and store on the data object
   */
  async #loadDirComponents(
    dir: Entry,
    parentComponents: Components,
    data: Partial<Data>,
  ): Promise<Components> {
    // Components registered from site.component()
    const scopedComponents = this.scopedComponents.get(dir.path);
    let loadedComponents: Components | undefined;

    // Load _components files
    for (const entry of dir.children.values()) {
      if (entry.type === "directory" && entry.name === "_components") {
        loadedComponents = await this.componentLoader.load(entry, data);
        break;
      }
    }

    // Merge the components
    if (scopedComponents || loadedComponents) {
      parentComponents = mergeComponents(
        parentComponents,
        scopedComponents || new Map(),
        loadedComponents || new Map(),
      );
    }

    return parentComponents;
  }

  async *#getDirPages(
    path: string,
    dirData: Partial<Data>,
  ): AsyncGenerator<Page> {
    const pages = this.scopedPages.get(path);
    if (!pages) {
      return;
    }

    for (const data of pages) {
      const basename = posix.basename(data.url as string).replace(
        /\.[\w.]+$/,
        "",
      );
      const page = new Page();
      page.data = mergeData(
        dirData,
        { basename, date: new Date() },
        data,
      ) as Data;

      const url = getPageUrl(page, this.prettyUrls, path);
      if (!url) {
        continue;
      }
      page.data.url = url;
      page.data.basename = getBasename(url);
      page.data.date = getPageDate(page);
      page.data.page = page;

      // Prevent running the layout if the page is an asset
      if (!data.layout && !page.outputPath.endsWith(".html")) {
        delete page.data.layout;
      }

      yield page;
    }
  }

  /** Load a page from a file entry */
  async #loadPage(
    entry: Entry,
    format: Format,
    dirData: Partial<Data>,
    dirPath: string,
    destination?: Destination | string,
  ): Promise<Page | undefined> {
    // The format is a page or asset
    const { loader, ext } = format;

    if (!loader) {
      throw new Error(
        `Missing loader for the page ${entry.path}`,
      );
    }

    const { basename, ...parsedData } = runBasenameParsers(
      entry.name.slice(0, -ext.length),
      this.basenameParsers,
    );

    // Create the page
    const page = new Page({
      path: entry.path.slice(0, -ext.length),
      ext,
      entry,
    });

    // Load and merge the page data
    const pageData = await entry.getContent(loader);
    page.data = mergeData(
      dirData,
      { basename },
      this.scopedData.get(entry.path) || {},
      parsedData,
      pageData,
    ) as Data;

    // Calculate the page URL
    const url = getPageUrl(page, this.prettyUrls, dirPath, destination);

    if (!url) {
      return;
    }
    page.data.url = url;
    page.data.basename = getBasename(url);

    // Calculate the page date
    page.data.date = getPageDate(page);

    // Save the page object in the data object
    page.data.page = page;

    // Prevent running the layout if the page is an asset
    if (!pageData.layout && !page.outputPath.endsWith(".html")) {
      delete page.data.layout;
    }

    return page;
  }
}

/**
 * Create and returns a proxy to use the components
 * as comp.name() instead of components.get("name").render()
 */
function toProxy(
  components: Components,
  extraCode?: Map<string, Map<string, string>>,
): ProxyComponents {
  const node = {
    _components: components,
    _proxies: new Map(),
  };
  return new Proxy(node, {
    get: (target, name) => {
      if (typeof name !== "string" || name in target) {
        return;
      }

      const key = name.toLowerCase();

      if (target._proxies.has(key)) {
        return target._proxies.get(key);
      }

      const component = target._components.get(key);

      if (!component) {
        throw new Error(`Component "${name}" not found`);
      }

      if (component instanceof Map) {
        const proxy = toProxy(component, extraCode);
        target._proxies.set(key, proxy);
        return proxy;
      }

      // Save CSS & JS code for the component
      if (extraCode) {
        if (component.css) {
          const code = extraCode.get("css") ?? new Map();
          code.set(key, component.css);
          extraCode.set("css", code);
        }

        if (component.js) {
          const code = extraCode.get("js") ?? new Map();
          code.set(key, component.js);
          extraCode.set("js", code);
        }
      }

      // Return the function to render the component
      return (props: Record<string, unknown>) => component.render(props);
    },
  }) as unknown as ProxyComponents;
}

export type Destination = (path: string) => string;

export type BuildFilter = (entry: Entry, page?: Page) => boolean;

export type BasenameParser = (filename: string) => RawData | undefined;

export interface ProxyComponents {
  // deno-lint-ignore no-explicit-any
  (props?: Record<string, unknown>): any;
  [key: string]: ProxyComponents;
}

/** Merge the cascade components */
function mergeComponents(...components: Components[]): Components {
  return components.reduce((previous, current) => {
    const components = new Map(previous);

    for (const [key, value] of current) {
      if (components.has(key)) {
        const previousValue = components.get(key);

        if (previousValue instanceof Map && value instanceof Map) {
          components.set(key, mergeComponents(value, previousValue));
        } else {
          components.set(key, value);
        }
      } else {
        components.set(key, value);
      }
    }
    return components;
  });
}

function runBasenameParsers(
  basename: string,
  basenameParsers: BasenameParser[],
): RawData {
  const data: RawData = { basename };

  for (const parser of basenameParsers) {
    const res = parser(basename);
    if (res === undefined) {
      continue;
    }
    res.basename ??= basename;
    Object.assign(data, res);
    if (res.basename === "") {
      break;
    }
  }

  return data;
}

function createFile(
  entry: Entry,
  ext: string,
  dirPath: string,
  dirData: Partial<Data>,
  destination?: string | Destination,
): StaticFile {
  const url = typeof destination === "string"
    ? destination
    : typeof destination === "function"
    ? destination(posix.join(dirPath, entry.name))
    : posix.join(dirPath, entry.name);

  return StaticFile.create({
    ...dirData,
    url,
  }, {
    ext,
    path: entry.path.slice(0, -ext.length),
    entry,
  });
}

function sortCSS(a: string, b: string) {
  if (a.includes("@import")) {
    return -1;
  }
  if (b.includes("@import")) {
    return 1;
  }
  return 0;
}
