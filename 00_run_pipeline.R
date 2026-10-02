# Run Pipeline -----------------------------------------------------------------
# The whole build, in order. Each step can also be run on its own:
#
#   Rscript 00_run_pipeline.R            # everything
#   Rscript 03_build_dashboard.R         # only the site, after a front-end or
#                                        # wording change (seconds)
#
# Step 01 is not a script: 01_variable_reference/ holds the hand-maintained
# tables the two scripts read.
steps <- c(
  # Every statistic the site shows, into outputs/02_dashboard_data/. Ten to
  # twenty-five minutes.
  "02_create_dashboard_data.R",
  # The deployable site, into outputs/03_site/. Seconds.
  "03_build_dashboard.R"
)

for (step in steps) {
  message("\n== ", step, " ==")
  # A fresh environment per step, so no step leans on what another left
  # behind and each runs the same here as on its own.
  source(here::here(step), local = new.env())
}
