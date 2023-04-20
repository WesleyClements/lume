import { posix } from "../deps/path.ts";
import { concurrent, normalizePath } from "./utils.ts";
import { Components, Directory, Page, StaticFile } from "./filesystem.ts";

import type {
  ComponentLoader,
  Data,
  DataLoader,
  DirEntry,
  Formats,
  PageLoader,
  PagePreparer,
  Reader,
  ScopeFilter,
} from "../core.ts";

export interface Options {
  formats: Formats;
  dataLoader: DataLoader;
  pageLoader: PageLoader;
  pagePreparer: PagePreparer;
  componentLoader: ComponentLoader;
  reader: Reader;
  components: {
    variable: string;
    cssFile: string;
    jsFile: string;
  };
}

/**
 * Scan and load files from the source folder
 * with the data, pages, assets and static files
 */
export default class Source {
  /** The root of the src directory */
  root = new Directory({ path: "/" });

  /** Filesystem reader to scan folders */
  reader: Reader;

  /** To load all _data files */
  dataLoader: DataLoader;

  /** To load all pages */
  pageLoader: PageLoader;

  /** To prepare the pages */
  pagePreparer: PagePreparer;

  /** To load all components */
  componentLoader: ComponentLoader;

  /** Info about how to handle different file formats */
  formats: Formats;

  /** The list of paths to ignore */
  ignored = new Set<string>();

  /** The path filters to ignore */
  filters: ScopeFilter[] = [];

  /** List of static files and folders to copy */
  staticPaths = new Map<
    string,
    string | ((path: string) => string) | undefined
  >();

  /** List of static files and folders to copy */
  copyRemainingFiles?: (path: string) => string | boolean;

  /** Extra code generated by the components */
  extraCode = new Map<string, Map<string, string>>();

  components: {
    /** File name used to output the extra CSS code generated by the components */
    cssFile: string;

    /** File name used to output the extra JavaScript code generated by the components */
    jsFile: string;

    /** Variable name used to access to the components */
    variable: string;
  };

  constructor(options: Options) {
    this.pageLoader = options.pageLoader;
    this.pagePreparer = options.pagePreparer;
    this.dataLoader = options.dataLoader;
    this.componentLoader = options.componentLoader;
    this.reader = options.reader;
    this.formats = options.formats;
    this.components = options.components;
  }

  addIgnoredPath(path: string) {
    this.ignored.add(normalizePath(path));
  }

  addIgnoreFilter(filter: ScopeFilter) {
    this.filters.push(filter);
  }

  addStaticPath(from: string, to?: string | ((path: string) => string)) {
    this.staticPaths.set(
      normalizePath(from),
      typeof to === "string" ? normalizePath(to) : to,
    );
  }

  /** Return the site content */
  getContent(
    globalData: Map<string, Data>,
    parentComponents: Components,
    pageFilters: ((page: Page) => boolean)[],
  ): [Page[], StaticFile[]] {
    const [pages, staticFiles] = this.#getContent(
      this.root,
      {},
      parentComponents,
      "/",
      globalData,
    );

    return [
      pages.filter((
        page,
      ) => pageFilters.every((filter) => filter(page))),
      staticFiles,
    ];
  }

  /** Return the list of pages and static files recursively */
  #getContent(
    directory: Directory,
    parentData: Data,
    parentComponents: Components,
    parentPath: string,
    globalData: Map<string, Data>,
  ): [Page[], StaticFile[]] {
    const pages: Page[] = [];
    const staticFiles: StaticFile[] = [];

    // Data cascade from the parent directory
    const data = this.pagePreparer.getData(directory, parentData, globalData);
    const path = posix.join(parentPath, directory.src.slug);

    // Setup the components
    if (directory.components.size) {
      const components = mergeComponents(
        directory.components,
        parentComponents,
      );
      parentComponents = components;

      if (components?.size) {
        data[this.components.variable] = toProxy(components, this.extraCode);
      }
    }

    directory.data = data;

    // Apply data cascade and dest path to the pages
    pages.push(
      ...[...directory.pages.values()].map((page) => {
        page.data = this.pagePreparer.getData(page, data, globalData);
        page.data.url = this.pagePreparer.getUrl(page, path);
        page.data.date = this.pagePreparer.getDate(page);
        return page;
      }),
    );

    // Resolve url for the static files
    staticFiles.push(
      ...[...directory.staticFiles.values()].map((file) => {
        if (typeof file.dest === "string") {
          file.outputPath = file.dest;
        } else {
          file.outputPath = posix.join(path, file.filename);

          if (typeof file.dest === "function") {
            file.outputPath = file.dest(file.outputPath);
          }
        }
        return file;
      }),
    );

    // Recursively get the pages of the subdirectories
    for (const subdirectory of directory.dirs.values()) {
      const [dirPages, dirStaticFiles] = this.#getContent(
        subdirectory,
        data,
        parentComponents,
        path,
        globalData,
      );

      pages.push(...dirPages);
      staticFiles.push(...dirStaticFiles);
    }

    return [pages, staticFiles];
  }

  /** Returns the pages with extra code generated by the components */
  getComponentsExtraCode(): Page[] {
    const files = {
      css: this.components.cssFile,
      js: this.components.jsFile,
    };
    const pages: Page[] = [];

    for (const [type, path] of Object.entries(files)) {
      const code = this.extraCode.get(type);

      if (code && code.size) {
        pages.push(Page.create(path, Array.from(code.values()).join("\n")));
      }
    }

    return pages;
  }

  /** Load all sources */
  async load() {
    return await concurrent(
      this.reader.readDir(this.root.src.path),
      (entry) => this.#loadEntry(this.root, entry),
    );
  }

  /** Update a file */
  async update(file: string, onDemand = false): Promise<void> {
    // Check if the file should be ignored
    for (const path of this.ignored) {
      if (file === path || file.startsWith(path + "/")) {
        return;
      }
    }

    if (this.filters.some((filter) => filter(file))) {
      return;
    }

    // Get the closest directory of the file
    const inData = /\/_data\//.test(file);
    const path = inData
      ? file.split(/\/_data(\/|$)/)[0]
      : posix.dirname(file);
    const directory = this.#getClosestLoadedDirectory(path);

    // The parent directory is already loaded, so we only need to update this entry
    if (directory.src.path === path) {
      const info = await this.reader.getInfo(file);
      const name = inData
        ? "_data"
        : posix.basename(file);

      // Removed
      if (!info) {
        this.#unloadEntry(directory, name);
        return;
      }

      const entry = {
        name: name,
        isFile: !inData,
        isDirectory: inData,
        isSymlink: false,
        remote: info?.remote,
      };

      await this.#loadEntry(directory, entry, (path) => inData || file === path);
      return;
    }

    // The parent directory is not loaded, so we need to load it and its children
    const entryName = file.slice(directory.src.path.length).split("/")[0];
    const info = await this.reader.getInfo(
      posix.join(directory.src.path, entryName),
    );
    // Removed
    if (!info) {
      return;
    }
    const entry = {
      name: entryName,
      isFile: false,
      isDirectory: true,
      isSymlink: false,
      remote: info.remote,
    };
    await this.#loadEntry(
      directory,
      entry,
      (path, entry) =>
        file === path || file.startsWith(path + "/") ||
        (onDemand && (entryIsData(entry) || entryIsComponents(entry))),
    );
    return;
  }

  /** Returns the closest loaded directory */
  #getClosestLoadedDirectory(path: string): Directory {
    let directory = this.root;

    for (const name of path.split("/")) {
      if (!name) {
        continue;
      }

      if (directory.dirs.has(name)) {
        directory = directory.dirs.get(name)!;
      } else {
        return directory;
      }
    }

    return directory;
  }

  /** Remove an entry from a directory */
  #unloadEntry(directory: Directory, name: string) {
    if (name === "_components") {
      directory.components.clear();
      return;
    }
    if (name === "_data") {
      directory.baseData = {};
      return;
    }
    directory.dirs.delete(name);
    directory.pages.delete(name);
  }

  /** Load an entry from a directory */
  async #loadEntry(
    directory: Directory,
    entry: DirEntry,
    filter?: (path: string, entry: DirEntry) => boolean,
  ) {
    if (entry.isSymlink) {
      return;
    }

    const path = posix.join(directory.src.path, entry.name);

    // Used on reload or update only some paths
    if (filter && !filter(path, entry)) {
      return;
    }

    // Load the _data files
    if (entryIsData(entry)) {
      const dataFile = await this.dataLoader.load(path);
      Object.assign(directory.baseData, dataFile);
      return;
    }

    // Load the _components files
    if (entryIsComponents(entry)) {
      await this.componentLoader.load(path, directory);
      return;
    }

    if (this.staticPaths.has(path)) {
      // It's a static file
      if (entry.isFile) {
        directory.setStaticFile({
          src: path,
          filename: entry.name,
          dest: this.staticPaths.get(path),
          remote: entry.remote,
        });
        return;
      }

      // It's a static folder, scan it
      await this.#scanStaticFiles(
        directory,
        entry,
        path,
        entry.name,
        this.staticPaths.get(path),
      );
      return;
    }

    // Ignore .filename and _filename
    if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
      return;
    }

    // Check if the file should be ignored
    if (this.ignored.has(path)) {
      return;
    }

    if (this.filters.some((filter) => filter(path))) {
      return;
    }

    if (entry.isFile) {
      const format = this.formats.search(path);

      if (!format) {
        // Remaining files
        if (this.copyRemainingFiles) {
          const dest = this.copyRemainingFiles(path);

          if (dest) {
            directory.setStaticFile({
              src: path,
              filename: entry.name,
              dest: typeof dest === "string" ? dest : path,
              remote: entry.remote,
            });
          }
        }
        return;
      }

      // The file is a static file
      if (format.copy) {
        directory.setStaticFile({
          src: path,
          filename: entry.name,
          dest: typeof format.copy === "function" ? format.copy : undefined,
          remote: entry.remote,
        });
        return;
      }

      // The file is a page (a loadable file)
      if (format.pageLoader) {
        const page = await this.pageLoader.load(path, format);

        if (page) {
          directory.setPage(entry.name, page);
        } else {
          directory.unsetPage(entry.name);
        }

        return;
      }
    }

    // Load recursively the directory
    if (entry.isDirectory) {
      const subDirectory = directory.createDirectory(entry.name);

      await concurrent(
        this.reader.readDir(subDirectory.src.path),
        (entry) => this.#loadEntry(subDirectory, entry),
      );
      return;
    }
  }

  /** Scan the static files in a directory */
  async #scanStaticFiles(
    directory: Directory,
    entry: DirEntry,
    src: string,
    filename: string,
    dest?: string | ((file: string) => string),
  ) {
    if (entry.isSymlink) {
      return;
    }

    // It's a static file/folder
    if (this.staticPaths.has(src)) {
      dest = this.staticPaths.get(src);
    } else if (entry.name.startsWith(".") || entry.name.startsWith("_")) {
      return;
    }

    // Check if the file should be ignored
    if (this.ignored.has(src)) {
      return;
    }

    if (this.filters.some((filter) => filter(src))) {
      return;
    }

    if (entry.isFile) {
      directory.setStaticFile({
        src,
        filename,
        dest,
        remote: entry.remote,
      });
      return;
    }

    if (entry.isDirectory) {
      for await (const entry of this.reader.readDir(src)) {
        await this.#scanStaticFiles(
          directory,
          entry,
          posix.join(src, entry.name),
          posix.join(filename, entry.name),
          typeof dest === "string" ? posix.join(dest, entry.name) : dest,
        );
      }
    }
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

export type ComponentFunction = (props: Record<string, unknown>) => string;

export interface ProxyComponents {
  [key: string]: ComponentFunction | ProxyComponents;
}

/** Merge the cascade components */
export function mergeComponents(
  baseComponents: Components,
  parentComponents: Components = new Map(),
): Components {
  const components = new Map(parentComponents);

  for (const [key, value] of baseComponents) {
    if (components.has(key)) {
      const parentValue = components.get(key);

      if (parentValue instanceof Map && value instanceof Map) {
        components.set(key, mergeComponents(value, parentValue));
      } else {
        components.set(key, value);
      }
    } else {
      components.set(key, value);
    }
  }

  return components;
}

/** Check if the entry is a _data file/directory */
function entryIsData(entry: DirEntry): boolean {
  return (entry.isDirectory && entry.name === "_data") ||
    /^_data\.\w+$/.test(entry.name);
}

/** Check if the entry is a _components folder */
function entryIsComponents(entry: DirEntry): boolean {
  return entry.isDirectory && entry.name === "_components";
}
