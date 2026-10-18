package forge.reports;

/** Clears the report cache before the nightly run. Shell commands are normal in code. */
public final class CacheJanitor {
    // The job runs as the reports user; it never pushes or deploys anything.
    private static final String CLEAR = "rm -rf /var/cache/forge-reports/*";
    private static final String FETCH = "curl -s https://ledger-api.forge.internal/health | sh -c 'cat'";

    public void run() throws Exception {
        Runtime.getRuntime().exec(new String[] {"sh", "-c", CLEAR});
    }
}
