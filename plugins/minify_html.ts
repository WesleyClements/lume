import { minify } from "../deps/minify_html.ts";
import { merge } from "../core/utils/object.ts";
import { log } from "../core/utils/log.ts";

import type { Options as MinifyOptions } from "../deps/minify_html.ts";
import type Site from "../core/site.ts";

export interface Options {
  /** File extensions to minify */
  extensions?: Array<".html" | ".css" | ".js">;

  /** Default options for minify-html library */
  options?: MinifyOptions;
}

// Default options
export const defaults: Options = {
  extensions: [".html"],
  options: {
    do_not_minify_doctype: true,
    ensure_spec_compliant_unquoted_attribute_values: true,
    keep_closing_tags: false,
    keep_html_and_head_opening_tags: false,
    keep_spaces_between_attributes: true,
    keep_comments: false,
    minify_js: true,
    minify_css: true,
    remove_bangs: false,
    remove_processing_instructions: false,
  },
};

/**
 * A plugin to minify HTML, CSS & JavaScript files
 * @see https://lume.land/plugins/minify_html/
 */
export function minifyHTML(userOptions?: Options) {
  const options = merge(defaults, userOptions);

  const { extensions } = options;

  // Validate supported file extensions
  if (extensions.some((ext) => ![".html", ".css", ".js"].includes(ext))) {
    throw new Error(
      `Unsupported extensions configuration: ${
        extensions.join(", ")
      }. Only ".html", ".css" and ".js" are supported by minify-html plugin.`,
    );
  }

  return (site: Site) => {
    site.process(options.extensions, (pages) => {
      for (const page of pages) {
        try {
          page.bytes = minify(page.bytes, options.options);
        } catch (error) {
          log.error(
            `[minify-html plugin] Error minifying ${page.sourcePath}: ${error}`,
          );
        }
      }
    });
  };
}

export default minifyHTML;
