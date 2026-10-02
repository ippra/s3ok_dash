# Paths ------------------------------------------------------------------------
# Every script sources this file, so data locations are defined once. The
# project is self-contained: the public wave files sit in data/, so paths
# resolve against the project root (the .here file) rather than a
# machine-specific root in ~/.Renviron. Nothing here needs configuring on a
# new machine.
project_root <- here::here()

# The released wave files, one per wave, as deposited on Dataverse
# (https://dataverse.harvard.edu/dataverse/msisnet). The dashboard is built
# from these and never from the unreleased S3OK_MSISNet_Wave_<n> files, which
# carry names, addresses, phone numbers and exact coordinates and are kept
# out of this project.
survey_files <- paste0(project_root, "/data/")

reference_dir <- file.path(project_root, "01_variable_reference")
site_src <- file.path(project_root, "site")
outputs <- paste0(project_root, "/outputs/")

# One row per question: wording as a stem and an item, response options and
# topic.
variable_reference <- file.path(reference_dir, "variable_reference.csv")
topics_reference <- file.path(reference_dir, "topics.csv")

# Which randomizer governs a split-sample question, and what its values mean.
question_arms_reference <- file.path(reference_dir, "question_arms.csv")
arms_reference <- file.path(reference_dir, "arms.csv")

# Questions taken off Explore Survey Questions, exported from the site with
# ?flag=1.
hidden_reference <- file.path(reference_dir, "hidden_questions.csv")

# Oklahoma's 77 counties (Census cartographic boundary file, 2023, via
# tigris::counties(state = "OK", cb = TRUE, year = 2023)) and the survey region
# each belongs to. The regions are drawn by dissolving the first by the second.
counties_reference <- file.path(reference_dir, "ok_counties_2023.geojson")
county_regions_reference <- file.path(reference_dir,
                                      "ok_counties_by_regions.csv")

# Respondent locations already displaced by up to 0.01 degrees for sharing.
# The map draws these and nothing more exact.
shared_locations <- paste0(
  survey_files, "S3OK_MSISNet_Wave_1_8_Shared_Location_Data.csv"
)

# Outputs are named for the script that writes them.
dashboard_data <- paste0(outputs, "02_dashboard_data/")
site_out <- paste0(outputs, "03_site/")

# The waves the dashboard covers. Adding one is a row here and its questions
# in the variable reference; every script iterates this table rather than
# naming files.
waves <- tibble::tribble(
  ~wave, ~file,
  1L,    "Public_Wave_1_Survey_Data.csv",
  2L,    "Public_Wave_2_Survey_Data.csv",
  3L,    "Public_Wave_3_Survey_Data.csv",
  4L,    "Public_Wave_4_Survey_Data.csv",
  5L,    "Public_Wave_5_Survey_Data.csv",
  6L,    "Public_Wave_6_Survey_Data.csv",
  7L,    "Public_Wave_7_Survey_Data.csv",
  8L,    "Public_Wave_8_Survey_Data.csv"
)
