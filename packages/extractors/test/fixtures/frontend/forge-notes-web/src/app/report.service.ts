import { HttpClient } from "@angular/common/http";
import { ReportConfig } from "./report-config";

/** Reports: the URL comes in from outside the file, so the reader keeps its expression. */
export class ReportService {
  private reportsUrl: string;

  constructor(
    private http: HttpClient,
    config: ReportConfig,
  ) {
    this.reportsUrl = config.reportsUrl;
  }

  weekly() {
    return this.http.get<string>(this.reportsUrl);
  }

  // Not calls the reader can say anything about: a bare parameter, a name then a parameter, a
  // file name with no path.
  raw(url: string) {
    return fetch(url);
  }

  under(path: string) {
    return fetch(BASE + path);
  }

  local() {
    return fetch("report.json");
  }
}

const BASE = import.meta.env.VITE_REPORTS_BASE;

export const exportAll = () => fetch(import.meta.env.VITE_REPORTS_BASE + "/exports");
