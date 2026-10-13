import type { Status } from "./git";

export const ALL_STATUSES: Status[] = ["A", "M", "D", "R"];

export interface Filter {
  /** Comma-separated in the UI; a leading `!` excludes. */
  globs: string[];
  statuses: Status[];
}

export function isActive(filter: Filter | undefined): filter is Filter {
  return !!filter && (filter.globs.length > 0 || filter.statuses.length < ALL_STATUSES.length);
}

export function describe(filter: Filter): string {
  const parts = [...filter.globs];
  const hidden = ALL_STATUSES.filter((s) => !filter.statuses.includes(s));
  if (hidden.length) parts.push(`상태 제외 ${hidden.join("")}`);
  return parts.join(", ");
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export class Matcher {
  private readonly include: RegExp[];
  private readonly exclude: RegExp[];
  private readonly statuses: Set<Status>;

  constructor(filter: Filter | undefined) {
    const globs = filter?.globs ?? [];
    this.include = globs.filter((g) => !g.startsWith("!")).map(globToRegExp);
    this.exclude = globs.filter((g) => g.startsWith("!")).map((g) => globToRegExp(g.slice(1)));
    this.statuses = new Set(filter?.statuses ?? ALL_STATUSES);
  }

  /** `status` undefined is an unchanged file: only the path globs apply to it. */
  matches(path: string, status?: Status): boolean {
    if (status && !this.statuses.has(status)) return false;
    if (this.include.length && !this.include.some((r) => r.test(path))) return false;
    return !this.exclude.some((r) => r.test(path));
  }
}
