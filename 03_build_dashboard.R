library(tidyverse)
library(jsonlite)

source(here::here("00_paths.R"))
source(here::here("helpers", "wording.R"))

# Dashboard Assembly -----------------------------------------------------------
# Builds the deployable site from what 02 computed and the hand-edited front
# end in site/. Seconds, where 02 takes minutes, so iterating on how the site
# looks or reads never pays for the statistics:
#
#   Rscript 02_create_dashboard_data.R   # when the data or the reference change
#   Rscript 03_build_dashboard.R         # always
#   python3 preview.py                   # then open http://127.0.0.1:8902/
#
# Assembly calculates NO statistics. Every percentage, mean and interval is
# read from outputs/02_dashboard_data/ verbatim, so the site cannot disagree
# with what was computed. What assembly adds is presentation: config.json (the
# pages and all their prose, the caption templates the front end fills), each
# region's rank and the median across regions for the map, and simplified
# geometry.
#
# Writes outputs/03_site/: plain static files with every library vendored and
# no third-party requests. Upload the directory to any web host.

# Where the site is published, for the citation on the About page.
site_url <- "https://ippra.net/s3okdash"

# Which deployment this build is for. The beta on GitHub Pages is built with
# S3OK_CHANNEL=beta, which labels the masthead and asks search engines not to
# index it, so the beta never competes with the production site in search.
# Unset, the build is production: the same site with neither.
channel <- Sys.getenv("S3OK_CHANNEL", "production")

if (!channel %in% c("production", "beta")) {
  stop("S3OK_CHANNEL is `", channel, "`; use `beta` or leave it unset.")
}

dataverse_url <- "https://dataverse.harvard.edu/dataverse/msisnet"
repo_url <- "https://github.com/ippra/s3ok_dash"

needed <- paste0(dashboard_data, c("questions.json", "splits.json",
                                   "respondents.json", "regions.geojson",
                                   "counties.geojson", "locations.json"))

if (!all(file.exists(needed))) {
  print(basename(needed[!file.exists(needed)]))
  stop("Files above are missing from ", dashboard_data,
       " - run 02_create_dashboard_data.R first.")
}

if (!dir.exists(site_src)) {
  stop("No site source at ", site_src, " - the site/ directory moved.")
}

# Rebuilt from scratch each run: a question dropped upstream must not survive
# here as a stale file.
unlink(site_out, recursive = TRUE)
for (d in c("data/q", "data/rcode", "data/trend", "data/trend_rcode",
            "data/topics",
            "data/narratives",
            "data/map", "data/geo")) {
  dir.create(paste0(site_out, d), recursive = TRUE, showWarnings = FALSE)
}

wjson <- function(x, path, pretty = FALSE) {
  write_json(x, paste0(site_out, path), pretty = pretty, auto_unbox = TRUE,
             na = "null", null = "null", digits = NA)
}

esc_html <- function(s) {
  s |>
    str_replace_all("&", "&amp;") |>
    str_replace_all("<", "&lt;") |>
    str_replace_all(">", "&gt;")
}

# "three" rather than "3" in running prose.
count_word <- function(n) {
  words <- c("one", "two", "three", "four", "five", "six", "seven", "eight",
             "nine", "ten")
  if (n >= 1 && n <= 10) words[n] else as.character(n)
}

en_dash <- function(s) str_replace_all(s, "-", "–")

# Question Data ----------------------------------------------------------------
# Copied through unchanged - these ARE the statistics, and they stay 02's.
q_files <- list.files(paste0(dashboard_data, "q"), full.names = TRUE)
if (length(q_files) == 0) stop("No question files in ", dashboard_data, "q.")
invisible(file.copy(q_files, paste0(site_out, "data/q/")))

question_list <- read_json(paste0(dashboard_data, "questions.json"),
                           simplifyVector = FALSE)
question_ids <- vapply(question_list, function(x) x$id, "")

# The randomizer behind each split-sample question, and the words each version
# put into the question, from the same declarations 02 used to split them.
question_arms_data <- read_csv(
  question_arms_reference,
  col_types = cols(.default = col_character())
)
arms_data <- read_csv(
  arms_reference,
  col_types = cols(arm_order = col_integer(), .default = col_character())
) |>
  arrange(arm_variable, arm_order)

arm_variables <- as.list(setNames(question_arms_data$arm_variable,
                                  question_arms_data$variable))
arm_wording <- lapply(
  split(arms_data, arms_data$arm_variable),
  function(x) as.list(setNames(coalesce(x$wording, ""), x$value))
)
arm_versions <- lapply(
  split(arms_data, arms_data$arm_variable),
  function(x) as.list(coalesce(x$wording, x$label))
)

# Hidden Questions -------------------------------------------------------------
# Questions Explore Survey Questions does not list, flagged in the browser with
# ?flag=1 and exported to hidden_questions.csv. `hide` takes a question off the
# list; `needs-context` only records it. The list is filtered here, not in 02:
# every question keeps its data and script files, so a change to the list needs
# no statistics run and a question can come back without one.
hidden_data <- read_csv(
  hidden_reference,
  col_types = cols(.default = col_character())
)
dispositions <- c("hide", "needs-context")

# A stale entry is worse than no entry: it looks like the question is hidden
# while the question is on the page.
unknown_hidden <- setdiff(hidden_data$id, question_ids)

if (length(unknown_hidden) > 0) {
  print(unknown_hidden)
  stop("Ids above are listed in hidden_questions.csv but are not questions.")
}

bad_disposition <- setdiff(hidden_data$disposition, dispositions)

if (length(bad_disposition) > 0) {
  print(bad_disposition)
  stop("Dispositions above are not one of: ",
       paste(dispositions, collapse = ", "))
}

if (anyDuplicated(hidden_data$id)) {
  print(hidden_data$id[duplicated(hidden_data$id)])
  stop("Ids above are listed more than once in hidden_questions.csv.")
}

drop_ids <- hidden_data$id[hidden_data$disposition == "hide"]
n_listed <- sum(!question_ids %in% drop_ids)
writeLines(
  toJSON(question_list[!question_ids %in% drop_ids], auto_unbox = TRUE,
         null = "null", na = "null", digits = NA),
  paste0(site_out, "data/questions.json")
)
message("Hidden from Explore Survey Questions: ", length(drop_ids))

# The R that rebuilds each chart, generated alongside the numbers it
# reproduces. Carried over the same way and for the same reason.
r_files <- list.files(paste0(dashboard_data, "rcode"), full.names = TRUE)

if (length(r_files) != length(q_files)) {
  stop(dashboard_data, " has ", length(q_files), " questions but ",
       length(r_files), " script files - Download R code would 404.")
}

invisible(file.copy(r_files, paste0(site_out, "data/rcode/")))
message("Questions carried over: ", length(q_files),
        ", with reproduction scripts for each")

# Change over time, for the questions asked in more than one wave. The index
# is what tells the page which questions offer that view, so a file without
# an entry, or an entry without a file, stops the build.
trend_files <- list.files(paste0(dashboard_data, "trend"), full.names = TRUE)
trend_ids <- unlist(read_json(paste0(dashboard_data, "trend/index.json")))

if (!setequal(paste0(trend_ids, ".json"),
              setdiff(basename(trend_files), "index.json"))) {
  stop("The trend index and the trend files in ", dashboard_data,
       " do not list the same questions.")
}

invisible(file.copy(setdiff(trend_files,
                            paste0(dashboard_data, "trend/index.json")),
                    paste0(site_out, "data/trend/")))

trend_r_files <- list.files(paste0(dashboard_data, "trend_rcode"),
                            full.names = TRUE)

if (!setequal(basename(trend_r_files), paste0(trend_ids, ".json"))) {
  stop("Not every question with a trend has the R that rebuilds it - ",
       "Download R code would 404.")
}

invisible(file.copy(trend_r_files, paste0(site_out, "data/trend_rcode/")))

# Respondents ------------------------------------------------------------------
respondents <- read_json(paste0(dashboard_data, "respondents.json"),
                         simplifyVector = TRUE)
waves_data <- as_tibble(respondents$waves) |>
  mutate(across(c(start, end), as.Date))

if (sum(waves_data$n) != respondents$rows) {
  stop("Per-wave counts in respondents.json do not add up to its total.")
}

# When a wave was in the field, read from the completion dates. The wave names
# in the files do not always match the season (Wave 1 is named Summer 2021 and
# ran in February and March), so the site shows the dates instead.
field_months <- function(start, end, month_format = "%B") {
  same_year <- format(start, "%Y") == format(end, "%Y")
  if (format(start, "%Y%m") == format(end, "%Y%m")) {
    return(format(end, paste(month_format, "%Y")))
  }
  paste0(
    format(start, month_format),
    if (same_year) "" else paste0(" ", format(start, "%Y")),
    " to ", format(end, month_format), " ", format(end, "%Y")
  )
}

waves_data <- waves_data |>
  mutate(
    fielded = map2_chr(start, end, field_months),
    fielded_short = map2_chr(start, end, field_months, month_format = "%b"),
    menu_name = paste0("Wave ", wave, " (", fielded_short, ")")
  )

year_span <- respondents$years
n_waves <- nrow(waves_data)

# Splits -----------------------------------------------------------------------
# The roster 02 computed under, read rather than declared again.
groupings_cfg <- read_json(paste0(dashboard_data, "splits.json"),
                           simplifyVector = FALSE) |>
  map(function(s) {
    list(id = s$id, label = s$label, phrase = s$phrase, levels = s$levels)
  })

# Key Topics -------------------------------------------------------------------
topic_files <- list.files(paste0(dashboard_data, "topics"), full.names = TRUE)
if (length(topic_files) == 0) stop("No topic files in ", dashboard_data, ".")
invisible(file.copy(topic_files, paste0(site_out, "data/topics/")))

topics <- map(topic_files, read_json, simplifyVector = FALSE)
# In the order the page offers them, which is not the alphabetical order the
# files list in.
topic_order <- c("priorities", "risk", "experience", "future", "trust")
unordered <- setdiff(map_chr(topics, "id"), topic_order)

if (length(unordered) > 0 || length(topics) != length(topic_order)) {
  print(unordered)
  stop("The key topics on disk are not the five the builder orders.")
}

topics <- topics[match(topic_order, map_chr(topics, "id"))]
topics_cfg <- map(topics, function(t) {
  list(id = t$id, group = t$group, label = t$label)
})

# A battery whose items were not all asked in the same waves says which were
# asked when, since its bars then rest on different responses.
topic_notes <- compact(setNames(map(topics, function(t) {
  asked <- map_chr(t$items, "asked")
  if (n_distinct(asked) == 1) return(NULL)
  usual <- names(which.max(table(asked)))
  odd <- keep(t$items, function(x) x$asked != usual)
  paste0(
    "Most items were asked in ", usual, "; ",
    paste(map_chr(odd, function(x) {
      paste0(x$label, " in ", x$asked)
    }), collapse = "; "), "."
  )
}), map_chr(topics, "id")))

# Region Values ----------------------------------------------------------------
# Every key-topic item for each of the five survey regions, for the overview
# sheet: the Region split 02 computed, turned on its side. Rank is
# presentation, derived here from those values: one more than the number of
# regions with a strictly greater value.
region_levels <- respondents$regions$region

measure_menu <- list(
  priorities = list(group = "Top priority (ranked first)",
                    prefix = "Ranked first: "),
  risk = list(group = "Perceived risk", prefix = "Perceived risk: "),
  experience = list(group = "Experienced in the last six months",
                    prefix = "Experienced: "),
  future = list(group = "Expected change in risk",
                prefix = "Expected change in risk: "),
  trust = list(group = "Trust in information from", prefix = "Trust: ")
)

region_measure <- function(values, extra = list()) {
  v <- unlist(values[region_levels])

  # Checked before the rank arithmetic, which reads a missing region as the
  # lowest: sum(v > NA) is NA, and the region would ship without a rank.
  if (length(v) != length(region_levels) || anyNA(v)) {
    stop("A mapped measure has no value for one of the regions.")
  }

  rank <- vapply(v, function(x) sum(v > x) + 1L, integer(1))
  c(
    list(
      values = as.list(v),
      rank = as.list(setNames(rank, region_levels)),
      domain = range(v)
    ),
    extra
  )
}

catalog <- list(list(
  code = "responses", label = "Survey responses", short = "Survey responses",
  group = "The survey panel", kind = "count", prompt = NULL
))
measure_values <- list(
  responses = region_measure(
    setNames(as.list(respondents$regions$responses), region_levels)
  )
)

for (t in topics) {
  rows <- t$splits$REGION

  for (item in t$items) {
    mine <- keep(rows, function(r) r$variable == item$variable)
    by_region <- function(field) {
      setNames(map(mine, field), map_chr(mine, "group"))
    }
    measure_values[[item$variable]] <- region_measure(
      by_region("value"),
      list(low = by_region("low")[region_levels],
           upp = by_region("upp")[region_levels],
           n = by_region("n")[region_levels])
    )
    catalog <- c(catalog, list(list(
      code = item$variable,
      label = paste0(measure_menu[[t$id]]$prefix, item$label),
      short = item$label,
      group = measure_menu[[t$id]]$group,
      kind = t$kind,
      prompt = t$prompt,
      set = t$id
    )))
  }
}

places <- setNames(
  pmap(respondents$regions, function(region, responses, people) {
    list(label = region, responses = responses, people = people)
  }),
  region_levels
)

wjson(list(places = places, measures = measure_values,
           areas = length(region_levels)), "data/map/region_values.json")

invisible(file.copy(paste0(dashboard_data, "locations.json"),
                    paste0(site_out, "data/map/locations.json")))
locations <- read_json(paste0(dashboard_data, "locations.json"))

# Geometry ---------------------------------------------------------------------
# The region and county outlines, already simplified by 02, carried over as
# they are.
drawn_regions <- paste0(dashboard_data, "regions.geojson") |>
  read_json() |>
  pluck("features") |>
  map_chr(function(f) f$properties$REGION)

if (!setequal(drawn_regions, region_levels)) {
  stop("The region geometry and the respondent counts name different regions.")
}

invisible(file.copy(
  paste0(dashboard_data, c("regions.geojson", "counties.geojson")),
  paste0(site_out, "data/geo/")
))

# Narratives -------------------------------------------------------------------
narrative_files <- list.files(paste0(dashboard_data, "narratives"),
                              full.names = TRUE)
invisible(file.copy(narrative_files, paste0(site_out, "data/narratives/")))

narrative_order <- c("water", "land", "infrastructure")
narrative_stems <- c(water = "water", land = "land", infrastructure = "infra")
narrative_headings <- c(
  water = "Concerns about water resources",
  land = "Concerns about land resources",
  infrastructure = "Concerns about infrastructure"
)
narratives <- map(
  paste0(dashboard_data, "narratives/", narrative_order, ".json"),
  read_json
)
narrative_wave <- unique(map_chr(narratives, "wave"))

if (length(narrative_wave) != 1) {
  stop("The narrative sets come from different waves, and the page ",
       "describes one.")
}

narrative_wave_row <- waves_data |>
  filter(paste("Wave", wave) == narrative_wave)
narrative_fielded <- paste0(narrative_wave, " · ",
                            narrative_wave_row$fielded)

narrative_sets <- map(narratives, function(x) {
  list(
    id = x$id, label = x$label, heading = unname(narrative_headings[x$id]),
    n = x$n, file = paste0("data/narratives/", x$id, ".json"),
    variables = paste0(c("problem_", "problem_cause_", "problem_solve_"),
                       narrative_stems[x$id])
  )
})

# Meta -------------------------------------------------------------------------
wjson(list(
  rows = respondents$rows,
  people = respondents$people,
  compiled = format(Sys.time(), "%Y-%m-%d %H:%M")
), "data/meta.json")

# Shared Sentences -------------------------------------------------------------
institute_link <- paste0(
  "<a href=\"https://ippra.net\">University of Oklahoma’s Institute ",
  "for Public Policy Research and Analysis</a>")
dataverse_link <- paste0(
  "<a href=\"", dataverse_url, "\">S³OK M-SISNet Dataverse</a>")
provenance <- paste0(
  "Results are from the S³OK Public Survey at the ", institute_link,
  ". They are unweighted and describe the survey’s panel of Oklahoma ",
  "adults.")
min_n <- respondents$min_group_n

# Map Notes --------------------------------------------------------------------
# The prose under the map: what the map shows and what the dots are, and
# where it all came from. Every number is read off the values above.
map_notes <- list(
  responses = paste0(
    "<p class=\"wx-lede\">Reading the map</p>",
    "<p class=\"wx-note-intro\">Oklahoma\u2019s five survey regions, each ",
    "a group of counties, with every person on the survey panel placed near ",
    "where they live.</p>",
    "<div class=\"wx-note-cols\"><div>",
    "<p><strong>The regions:</strong> ",
    paste(region_levels[-length(region_levels)], collapse = ", "), ", and ",
    region_levels[length(region_levels)], ", named for their largest city ",
    "or their part of the state. A response is counted in the region where ",
    "the respondent lived when they answered, so a panelist who moved ",
    "between waves is counted in each. Hovering a region shows how many ",
    "responses it gave across all ", count_word(n_waves), " waves.</p>",
    "</div><div>",
    "<p><strong>The dots:</strong> Each dot is one of ",
    format(locations$n, big.mark = ","), " panelists, placed near where they ",
    "live. Every location was moved by a random distance of up to about a ",
    "kilometer before it was shared, so a dot does not mark a home. ",
    "Panelists with no usable location are not drawn.</p>",
    "<p>", provenance, "</p>",
    "<p>Survey data: ", dataverse_link, "</p>",
    "</div></div>")
)

if (is.null(map_notes$responses)) {
  stop("The measure the map draws has nothing said underneath it.")
}

scan_lede <- paste0(
  "<p>Each row is one measure, with the chosen region as a dot and the ",
  "other ", count_word(length(region_levels) - 1), " as diamonds on a line ",
  "that runs from the lowest region to the highest. Priorities and ",
  "experiences are percentages of responses; risk, expected change, and ",
  "trust are average ratings on a 1-to-5 scale. Rank orders the ",
  count_word(length(region_levels)), " regions from the highest value ",
  "(1st) to the lowest. Because measures use different scales and ranges, ",
  "compare the region&rsquo;s position within each row, not the position ",
  "of dots across rows.</p>")
scan_note <- paste0(
  "<p>", provenance, " Values are for the respondents living in each ",
  "region, pooled across the waves that asked each question. With only ",
  count_word(length(region_levels)), " regions, a rank can turn on a small ",
  "difference; regions differ in how many people answered, and small ",
  "differences between them may not be meaningful.</p>",
  "<p>Survey data: ", dataverse_link, "</p>")

# Project At A Glance ----------------------------------------------------------
# The landing page's four figures and the dot field beside its statement,
# counted off 02's output so they move with every run rather than being typed
# and left to go stale.
landing_stats <- list(
  list(value = format(respondents$rows, big.mark = ","),
       label = "Survey responses"),
  list(value = format(respondents$people, big.mark = ","),
       label = "Oklahomans on the survey panel"),
  list(value = paste(n_waves, "waves"),
       label = paste0("of data collection, ", year_span[1], " to ",
                      year_span[2])),
  list(value = paste(respondents$questions, "questions"),
       label = paste0("on water, land, energy, infrastructure, weather, ",
                      "and trust"))
)
message("Landing: ", paste(map_chr(landing_stats, "value"), collapse = ", "))

# The landing page, the About page and the menu all describe the four working
# pages, so each description is written once here.
blurbs <- list(
  survey = paste0("Browse every survey question and compare responses across ",
                  "demographic groups, regions, and survey waves."),
  topics = paste0("See whole sets of related questions on one chart: ",
                  "priorities, weather and climate hazards, and trust."),
  regions = paste0("Compare priorities, hazard perceptions, and trust across ",
                   "Oklahoma’s five survey regions, and see where ",
                   "panelists live."),
  narratives = paste0("Read what Oklahomans wrote about the water, land, and ",
                      "infrastructure problems that concern them.")
)

about_link <- function(id, name, body) {
  paste0(
    "<a class=\"wx-about-link\" href=\"#", id, "\">",
    "<span class=\"wx-about-link-name\">", name, "</span>",
    "<span class=\"wx-about-link-body\">", body, "</span></a>"
  )
}

# Publications using the survey, each linked by DOI. One format for every
# entry: the title as the link, then "Authors (Year). Journal, detail." with
# only the journal in italics; newest first. The details are read off the
# papers themselves.
pub <- function(year, title, authors, journal, detail, doi) {
  list(year = year, title = title, authors = authors, journal = journal,
       detail = detail, doi = doi)
}
publications <- list(
  pub(2024, "Public Support for Producer Adoption of Soil Health Practices",
      paste0("Lambert, D. M., Lambert, L. H., Ripberger, J., Jenkins-Smith, ",
             "H., & Silva, C. L."),
      "Agriculture and Human Values", "",
      "10.1007/s10460-024-10660-6"),
  pub(2023, paste0("Watts at Stake: Concern and Willingness-to-Pay for ",
                   "Electrical Grid Improvements in the United States"),
      paste0("Long, M. A., León-Corwin, M., Peach, K., Olofsson, K. L., ",
             "Ripberger, J. T., Gupta, K., Silva, C. L., & Jenkins-Smith, H."),
      "Energy Research & Social Science", ", 102, 103179",
      "10.1016/j.erss.2023.103179"),
  pub(2022, paste0("Public Willingness to Pay for Farmer Adoption of Best ",
                   "Management Practices"),
      "Lambert, L. H., Lambert, D. M., & Ripberger, J. T.",
      "Journal of Agricultural and Applied Economics", ", 54, 224–241",
      "10.1017/aae.2022.4"),
  pub(2020, paste0("Mismatches in Prescribed Fire Awareness and ",
                   "Implementation in Oklahoma, USA"),
      paste0("Polo, J. A., Tanner, E. P., Scholtz, R., Fuhlendorf, S. D., ",
             "Ripberger, J. T., Silva, C. L., Jenkins-Smith, H. C., & ",
             "Carlson, N."),
      "Rangelands", ", 42(6), 196–202", "10.1016/j.rala.2020.09.002")
)
pub_years <- vapply(publications, function(x) x$year, double(1))

if (is.unsorted(rev(pub_years))) {
  stop("Publications are not listed newest first; keep the list in order.")
}

pub_html <- function(x) {
  paste0("<p class=\"wx-pub\"><a class=\"wx-pub-title\" ",
         "href=\"https://doi.org/", x$doi, "\">", x$title, "</a>",
         "<span class=\"wx-pub-cite\">", x$authors, " (", x$year, "). <em>",
         x$journal, "</em>", x$detail, ".</span></p>")
}
publications_html <- paste0(unlist(lapply(unique(pub_years), function(y) {
  c(paste0("<h4 class=\"wx-pub-year\">", y, "</h4>"),
    vapply(publications[pub_years == y], pub_html, ""))
})), collapse = "")

wave_table_html <- paste0(
  "<table class=\"s3-wave-table\"><thead><tr><th scope=\"col\">Wave</th>",
  "<th scope=\"col\">In the field</th>",
  "<th scope=\"col\" class=\"num\">Responses</th></tr></thead><tbody>",
  paste0(
    "<tr><td>Wave ", waves_data$wave, "</td><td>",
    format(waves_data$start, "%B %e, %Y") |> str_squish(), " to ",
    format(waves_data$end, "%B %e, %Y") |> str_squish(),
    "</td><td class=\"num\">", format(waves_data$n, big.mark = ","),
    "</td></tr>", collapse = ""),
  "</tbody></table>")

# The About page is one column of prose in sections, each under an eyebrow
# heading. The opening paragraph is the reason the project exists, so it is
# set as the lede rather than under a heading. Figures in it are read from
# the data like everywhere else.
about_html <- paste0(
  "<p class=\"wx-about-lede\">Oklahoma faces connected challenges in how it ",
  "manages water, land, and infrastructure under a variable and changing ",
  "climate. Solutions to those challenges last only when the people who ",
  "live with them understand them, support them, and can sustain them.</p>",
  "<p>The S³OK project (Socially Sustainable Solutions for Water, ",
  "Carbon, and Infrastructure Resilience in Oklahoma) is a research program ",
  "supported by the National Science Foundation through OK NSF EPSCoR. The ",
  "S³OK Public Survey is how the project asks Oklahomans directly what ",
  "concerns them, what they have experienced, whom they trust, and which ",
  "solutions they would support. This site makes the results available to ",
  "researchers, decision makers, and the public.</p>",

  "<hr>",
  "<h3>The survey</h3>",
  "<p>The S³OK Public Survey is a panel survey of Oklahoma adults ",
  "conducted online by the ", institute_link, " (IPPRA). It continues the ",
  "Oklahoma Meso-Scale Integrated Socio-geographic Network (M-SISNet), a ",
  "survey panel begun in 2014 whose members were recruited from an ",
  "address-based random sample of Oklahoma households.</p>",
  "<p>The same panelists are invited back for each wave, so many have ",
  "answered more than once: ", format(respondents$people, big.mark = ","),
  " people have given ", format(respondents$rows, big.mark = ","),
  " responses across ", count_word(n_waves), " waves, and ",
  format(respondents$all_waves, big.mark = ","), " of them answered every ",
  "wave. Each wave repeats a core set of questions on concerns about water, ",
  "land, and infrastructure, on weather and climate hazards, and on trust, ",
  "and adds questions on a topic of its own, such as the electric grid, ",
  "household water, land management, transportation, energy development, or ",
  "water reuse.</p>",
  wave_table_html,

  "<hr>",
  "<h3>Interpreting survey results</h3>",
  "<p>Results on this site are unweighted. The public data files carry no ",
  "survey weights, so every percentage and average describes the people who ",
  "answered rather than a weighted estimate for all Oklahoma adults. Panel ",
  "respondents are older than the state’s adult population (the median ",
  "age across responses is ", respondents$age_median, "), and ",
  respondents$female_pct, "% of responses come from women, so results should ",
  "be read as the views of this panel.</p>",
  "<p>Because the survey is a panel, a chart that pools several waves counts ",
  "a person once for each wave they answered. Captions give both the number ",
  "of responses and the number of people behind them, and comparing by ",
  "survey wave shows change over time. Confidence intervals, where shown, ",
  "allow for repeated answers from the same person. They reflect sampling ",
  "variation only and not every source of survey error.</p>",
  "<p>Most results describe what respondents report believing, preferring, ",
  "or doing. Groups with fewer than ", min_n, " responses to a question are ",
  "not charted. Some questions were asked in more than one version, ",
  "assigned at random; those carry a version menu, and each version is ",
  "shown on its own. Percentages may not sum to exactly 100 because of ",
  "rounding.</p>",

  "<hr>",
  "<h3>Regions and respondent locations</h3>",
  "<p>Explore Regions summarizes the key topics for five survey regions, ",
  "each a group of counties: ",
  paste(region_levels[-length(region_levels)], collapse = ", "), ", and ",
  region_levels[length(region_levels)], ". Values are the unweighted results ",
  "for respondents living in each region, not modeled estimates, and regions ",
  "with fewer respondents carry wider confidence intervals.</p>",
  "<p>The dots on the map show approximately where panelists live. Every ",
  "location was moved by a random distance of up to about a kilometer ",
  "before it was shared, so a dot does not mark a home, and dots carry no ",
  "information about how anyone answered.</p>",

  "<hr>",
  "<h3>Policy narratives</h3>",
  "<p>In the first wave, respondents were asked to describe in their own ",
  "words the water, land, and infrastructure problems that concern them, ",
  "who or what is causing those problems, and what might fix them. Policy ",
  "Narratives shows those answers as they were written, without editing or ",
  "coding. They are the views of individual respondents.</p>",

  "<hr>",
  "<h3>Using this site</h3>",
  "<div class=\"wx-about-links\">",
  about_link("survey", "Explore Survey Questions", paste0(
    "Browse survey questions and results across topics, waves, and groups. ",
    "Select a question to see how the panel answered or compare responses ",
    "across different groups.")),
  about_link("topics", "Explore Key Topics", paste0(
    "See what Oklahomans say needs the most attention, how they rate and ",
    "experience weather and climate hazards, and whose information they ",
    "trust, with every item of a topic on one chart.")),
  about_link("regions", "Explore Regions", paste0(
    "Explore how priorities, hazard perceptions, and trust vary across ",
    "Oklahoma’s five survey regions. Select a region to see all of ",
    "its measures.")),
  about_link("narratives", "Policy Narratives", paste0(
    "Read and search what respondents wrote about the problems that ",
    "concern them, their causes, and possible fixes.")),
  "</div>",

  "<hr>",
  "<h3>Data and reproducibility</h3>",
  "<p>Survey data, questionnaires, and codebooks for each wave are available ",
  "through the ", dataverse_link, " on Harvard Dataverse. Every result on ",
  "this site is computed from those public files.</p>",
  "<p>The code that builds this site, including the statistics it shows ",
  "and the question wording checked against each survey instrument, is ",
  "available in the <a href=\"", repo_url, "\">S\u00b3OK dashboard GitHub ",
  "repository</a>. Each chart on Explore Survey Questions also offers ",
  "Download R code, a script that rebuilds that chart from the public ",
  "survey data and nothing else.</p>",

  "<hr>",
  "<h3>Publications using the survey</h3>",
  "<p>The survey is a resource for research as well as a record of public ",
  "opinion. Peer-reviewed research using the S³OK waves and the ",
  "M-SISNet panel they continue includes:</p>",
  "<div class=\"wx-pubs\">", publications_html, "</div>",
  "<p>Have you published research using these data? We would like to include ",
  "it here. Please contact <a href=\"mailto:jtr@ou.edu\">Joe Ripberger</a> at ",
  "OU IPPRA.</p>",

  "<hr>",
  "<h3>Citing this site</h3>",
  "<p>University of Oklahoma Institute for Public Policy Research and ",
  "Analysis. (2021). <em>Public Survey on Socially Sustainable Solutions for ",
  "Water, Carbon, and Infrastructure Resilience in Oklahoma</em>. Retrieved ",
  "from <a href=\"", site_url, "\">", site_url, "</a>.</p>",

  "<hr>",
  "<h3>Support</h3>",
  "<p>Funding for this project was provided by the National Science ",
  "Foundation under Grant No. OIA-1946093 through OK NSF EPSCoR.</p>",
  "<div class=\"s3-funders\">",
  "<img src=\"./assets/img/nsf.png\" alt=\"National Science Foundation\">",
  "<img class=\"s3-funder-wide\" src=\"./assets/img/ok-nsf-epscor.png\" ",
  "alt=\"Oklahoma EPSCoR, Established Program to Stimulate Competitive ",
  "Research\">",
  "</div>",
  "<p>Any opinions, findings, and conclusions presented on this site are ",
  "those of the project and do not necessarily reflect the views of the ",
  "National Science Foundation.</p>",

  "<hr>",
  "<h3>Contact</h3>",
  "<p>Questions about the project, the survey data, or use of the data are ",
  "welcome.</p>",
  "<p class=\"wx-about-contact\"><a href=\"mailto:jtr@ou.edu\">Joe ",
  "Ripberger</a><br>Institute for Public Policy Research and Analysis<br>",
  "University of Oklahoma</p>"
)

# Config -----------------------------------------------------------------------
# Everything the front end reads that is not question, topic or map data:
# pages and their prose, the split roster with caption phrases, and the caption
# and popup templates ({tokens} filled at render time).
config <- list(
  schema_version = 3,
  project = list(
    slug = "s3ok",
    title = "S³OK — Oklahoma Public Survey Dashboard",
    nav_title = "S³OK",
    nav_subtitle = "Socially Sustainable Solutions for Oklahoma",
    beta = channel == "beta"
  ),
  theme = list(default = "s3ok", allow_viewer_switch = TRUE),
  groupings = groupings_cfg,
  waves = map2(waves_data$wave, waves_data$menu_name,
               function(wave, name) list(wave = wave, name = name)),
  min_group_n = min_n,
  # Questions asked in more than one wave, which offer the view of change
  # over time. Hidden questions are not listed, so are left out.
  trend_questions = as.list(setdiff(trend_ids, drop_ids)),
  wave_names = as.list(setNames(waves_data$fielded_short, waves_data$wave)),
  # The note under each chart, in four parts: who and when as one line of
  # facts, what the bars are, where the data come from, and the handles a
  # reader needs to find the question again. Every {token} is filled from the
  # question file, so no line states a figure the data does not carry.
  explore_caption = list(
    meta = "{n} Oklahoma adults · {waves} · {years}",
    # A count over several waves is of responses, not people: the same
    # panelists answer wave after wave.
    meta_pooled = paste0("{n} responses from {people} Oklahoma adults ",
                         "· {waves} · {years}"),
    # The view of change over time, on a balanced sample. One sentence per
    # kind of estimate, then the comparison's.
    trend_meta = paste0("{n} Oklahoma adults who answered in all {k} waves ",
                        "\u00b7 {waves} \u00b7 {years}"),
    trend_mean = paste0("The line shows the average answer in each wave, on ",
                        "the scale of the response options. Only ",
                        "respondents who answered this question in every one ",
                        "of these waves are counted, so a change is a change ",
                        "in answers rather than in who took part; this is a ",
                        "smaller group than the bar chart describes."),
    trend_share = paste0("The line shows the percentage answering yes in ",
                         "each wave. Only respondents who answered this ",
                         "question in every one of these waves are counted, ",
                         "so a change is a change in answers rather than in ",
                         "who took part; this is a smaller group than the ",
                         "bar chart describes."),
    trend_options = paste0("Each line is one answer: the percentage giving ",
                           "it in each wave. Only respondents who answered ",
                           "this question in every one of these waves are ",
                           "counted, so a change is a change in answers ",
                           "rather than in who took part; this is a smaller ",
                           "group than the bar chart describes. The answers ",
                           "have no order, so there is one line per answer ",
                           "and no comparison by group."),
    # A person's group can change between waves, so the caption says which
    # wave's group a line follows.
    trend_split = paste0(" There is one line per {group_phrase}, as it was ",
                         "in the first of these waves."),
    trend_smallest = paste0(" The smallest group, {smallest}, includes ",
                            "{smallest_n} respondents."),
    trend_not_shown = paste0(" Groups with fewer than {min} respondents are ",
                             "not shown: {groups}."),
    bars = "Bars show the percentage selecting each response.",
    bars_split = paste0("Bars show the percentage of each {group_phrase} ",
                        "selecting each response."),
    smallest = paste0(" The smallest group, {smallest}, includes ",
                      "{smallest_n} responses."),
    not_shown = paste0(" Groups with fewer than {min} responses are not ",
                       "shown: {groups}."),
    pooled = paste0(" {waves} are pooled, and a person who answered in more ",
                    "than one wave is counted once for each, so this ",
                    "describes those waves together; compare by survey wave ",
                    "to see change."),
    # What the intervals are, said only while they are drawn. srvyr's
    # survey_prop() on a design clustered on the panelist.
    ci = paste0(" Error bars are 95% confidence intervals for a proportion ",
                "(logit method) that allow for repeated answers from the ",
                "same person. They reflect sampling variation only."),
    provenance = provenance,
    reference = paste0(
      "Variable: <code>{variable}</code>{randomization} · Data: ",
      dataverse_link),
    randomized = paste0(" Respondents were randomly assigned one version; ",
                        "the menu above shows each."),
    varied = " Wording in brackets varied between respondents.",
    randomization = " · Randomization: <code>{names}</code>",
    piped = " · Wording varies with: <code>{names}</code>"
  ),
  # The same note for a key topic, where a bar is an item's mean or share
  # rather than a response's share.
  topic_caption = list(
    mean = "Bars show the average rating of each item.",
    mean_split = paste0("Bars show the average rating of each item among ",
                        "each {group_phrase}."),
    share = "Bars show the percentage answering yes for each item.",
    share_split = paste0("Bars show the percentage of each {group_phrase} ",
                         "answering yes for each item."),
    top = "Bars show the percentage ranking each item first.",
    top_split = paste0("Bars show the percentage of each {group_phrase} ",
                       "ranking each item first."),
    ci_mean = paste0(" Error bars are 95% confidence intervals for a mean ",
                     "that allow for repeated answers from the same person. ",
                     "They reflect sampling variation only."),
    ci_share = paste0(" Error bars are 95% confidence intervals for a ",
                      "proportion (logit method) that allow for repeated ",
                      "answers from the same person. They reflect sampling ",
                      "variation only."),
    reference = paste0("Variables: {variables} · Data: ", dataverse_link)
  ),
  topics = topics_cfg,
  topic_notes = topic_notes,
  arm_variables = arm_variables,
  arm_wording = arm_wording,
  arm_versions = arm_versions,
  # Placeholders in question wording that are not a version menu's own
  # variable, in words a reader can follow.
  placeholders = as.list(placeholder_words),
  catalog = catalog,
  map = list(
    notes = map_notes,
    scan = list(lede = scan_lede, note = scan_note),
    # The one sentence a region's popup carries.
    popup = list(
      count = paste0("{value} survey responses came from this region across ",
                     "all waves, from {people} panelists.")
    ),
    figure = list(
      meta = "{areas} survey regions · Oklahoma",
      regions = paste0("Each color is one survey region, a group of counties ",
                       "named for its largest city or its part of the state."),
      dots = "Dots show approximately where panelists live."
    )
  ),
  pages = list(
    list(id = "home", component = "wx_landing", label = "Home",
         hero = list(
           eyebrow = paste0("S³OK Public Survey Project · ",
                            "University of Oklahoma"),
           # Two lines, broken where the phrase breaks; a narrow screen
           # wraps each line on its own.
           headline = list("Socially Sustainable Solutions for Water, Carbon,",
                           "and Infrastructure Resilience in Oklahoma"),
           intro = paste0("Solutions to Oklahoma’s water, land, and ",
                          "infrastructure challenges last only when the ",
                          "people who live with them have a say in what ",
                          "they are."),
           statement = list(
             "Science and engineering can tell us what is possible.",
             "Oklahomans can tell us which solutions they will support."),
           description = paste0(
             "The S³OK Public Survey gathers input, advice, and ",
             "guidance from people across the state on how best to address ",
             "pressing challenges related to water, carbon, and ",
             "infrastructure. Since ", year_span[1], ", the same panel of ",
             "residents has been invited back wave after wave to say what ",
             "concerns them, what they have experienced, whom they trust, ",
             "and which solutions they prefer."),
           # Set in bold after the paragraph: what the effort adds up to.
           description_close = paste0(
             "By sharing their perspectives, residents are helping to shape ",
             "solutions that strengthen communities and support long-term ",
             "resilience in Oklahoma.")),
         # The hero is a map of where the panel lives, drawn from the same
         # displaced locations Explore Regions shows.
         map = list(
           points = "data/map/locations.json",
           regions = "data/geo/regions.geojson",
           counties = "data/geo/counties.geojson",
           title = "A panel that spans the state",
           caption = paste0(
             "Each dot is one of ", format(locations$n, big.mark = ","),
             " Oklahomans on the survey panel, placed near where they ",
             "live. Locations are approximate.")),
         stats = landing_stats,
         sections = list(
           list(columns = list(
             list(lead = "Why public input matters",
                  body = paste0(
                    "Decisions about water, land, and infrastructure shape ",
                    "daily life, and the people affected differ in what ",
                    "worries them, what they have lived through, and whom ",
                    "they trust to get it right. A solution that works on ",
                    "paper can fail if it ignores those differences. ",
                    "Asking residents directly gives scientists and ",
                    "policymakers a clearer picture of the people and ",
                    "communities they serve.")),
             list(lead = "Why a panel matters",
                  body = paste0(
                    "One survey provides a snapshot. Returning to the same ",
                    "panel of Oklahomans wave after wave shows how concerns ",
                    "and experiences change with drought, storms, prices, ",
                    "and policy. Core questions are repeated to track those ",
                    "changes, while each wave adds new questions on an ",
                    "emerging topic, from the electric grid to water ",
                    "reuse."))))),
         explore = list(
           heading = "Explore the Data",
           intro = paste0("Explore survey questions and results, see key ",
                          "topics at a glance, compare regions of the ",
                          "state, or read what Oklahomans said in their own ",
                          "words."),
           cards = list(
             list(page = "survey", label = "Explore Survey Questions",
                  body = blurbs$survey, cta = "Explore the Survey →"),
             list(page = "topics", label = "Explore Key Topics",
                  body = blurbs$topics, cta = "Explore Key Topics →"),
             list(page = "regions", label = "Explore Regions",
                  body = blurbs$regions, cta = "Explore Regions →"),
             list(page = "narratives", label = "Policy Narratives",
                  body = blurbs$narratives,
                  cta = "Read the Narratives →")))),
    list(id = "survey", component = "explore",
         label = "Explore Survey Questions",
         title = "Explore Survey Questions",
         questions = "data/questions.json", default_grouping = "All",
         # The count is read, not typed: the questions the browser lists,
         # hidden ones left out, rounded down to the hundred below so "more
         # than" stays true as questions are added or hidden.
         intro = paste0("Explore what Oklahomans think about water, land, ",
                        "energy, infrastructure, weather, and the decisions ",
                        "ahead. Browse more than ",
                        floor((n_listed - 1) / 100) * 100, " survey ",
                        "questions asked across ", count_word(n_waves),
                        " waves since ", year_span[1], ". Select any ",
                        "question to see how the panel answered or compare ",
                        "responses across different groups."),
         # No title on the response axis: its labels are the answers.
         chart = list(y_label = "Respondents (%)"),
         blurb = blurbs$survey),
    list(id = "topics", component = "s3_topics",
         label = "Explore Key Topics",
         title = "Explore Key Topics",
         default_topic = "priorities",
         intro = paste0("See a whole set of related questions on one chart: ",
                        "what Oklahomans say needs the most attention, how ",
                        "they rate and experience weather and climate ",
                        "hazards, and whose information they trust. Choose ",
                        "a topic, then compare responses across groups, ",
                        "regions, or survey waves."),
         blurb = blurbs$topics),
    list(id = "regions", component = "s3_region_map",
         label = "Explore Regions",
         title = "Explore Regions",
         default_measure = "responses",
         # What the map is, named above it the way the survey page names its
         # question.
         map_kind = "The survey panel",
         map_title = "The five survey regions",
         intro = list(
           paste0("See where the people on the survey panel live, and ",
                  "how priorities, hazard perceptions, and trust differ ",
                  "across Oklahoma’s ",
                  count_word(length(region_levels)), " survey regions."),
           paste0("The map shows the regions and the panel. Choose a region ",
                  "there or in the Region overview table further down, and ",
                  "the table lists every measure for it: what its ",
                  "respondents rank as the top priority, how they rate and ",
                  "experience weather and climate hazards, how they expect ",
                  "those risks to change, and whom they trust, each set ",
                  "against the other four regions.")),
         hint = paste0("Hover a region to see how many responses it gave; ",
                       "click it to fill the Region overview table below. ",
                       "Dots show approximately where panelists live."),
         blurb = blurbs$regions),
    list(id = "narratives", component = "s3_narratives",
         label = "Policy Narratives",
         title = "Policy Narratives",
         intro = paste0("Read what Oklahomans said in their own words. In ",
                        "the first wave of the survey, respondents were ",
                        "asked to describe the water, land, and ",
                        "infrastructure problems that concern them, who or ",
                        "what is causing those problems, and what might fix ",
                        "them. Choose a resource, then search or filter the ",
                        "responses."),
         fielded = narrative_fielded,
         sets = narrative_sets,
         # The three questions as asked head the columns; the short labels
         # stand in for them where the columns stack.
         prompts = list(
           list(key = "problem", label = "The problem",
                question = paste0("Can you briefly describe the problem(s) ",
                                  "that concern you?")),
           list(key = "cause", label = "Who or what is causing it",
                question = paste0("Can you briefly describe who/what is ",
                                  "causing the problem(s)?")),
           list(key = "solve", label = "What might fix it",
                question = paste0("Do you have any ideas about what might ",
                                  "fix the problem(s)?"))),
         caption = list(
           meta = paste0("{n} responses about {label} · ",
                         narrative_fielded),
           note = paste0("Responses are shown as respondents wrote them, ",
                         "without editing, and are the views of individual ",
                         "respondents. A response is listed wherever a ",
                         "problem was described; a part left blank reads No ",
                         "answer."),
           reference = paste0("Variables: {variables} · Data: ",
                              dataverse_link)),
         blurb = blurbs$narratives),
    list(id = "about", component = "static_page", label = "About",
         title = "About the S³OK Public Survey Project",
         html = about_html)
  ),
  # The footer names the project rather than the site, so it reads the same
  # at the foot of every page as the headline does on the home page.
  footer = list(
    name = "S³OK Public Survey Project",
    tagline = paste0("Socially Sustainable Solutions for Water, Carbon, and ",
                     "Infrastructure Resilience in Oklahoma"),
    links_html = paste0(
      "<a href=\"#about\">About & methods</a>",
      "<a href=\"", dataverse_url, "\">Survey data (Dataverse)</a>",
      "<a href=\"https://ippra.net\">OU IPPRA</a>",
      "<a href=\"mailto:jtr@ou.edu\">Contact</a>"),
    funding = paste0("Supported by the National Science Foundation under ",
                     "Grant No. OIA-1946093 through OK NSF EPSCoR.")
  )
)
wjson(config, "config.json", pretty = TRUE)

# Site Files -------------------------------------------------------------------
# Everything under site/ is copied through: it is the hand-edited source, kept
# editable as itself rather than generated from R strings. index.html is the
# one exception - the __BUILD__ stamp is filled in so asset URLs bust
# long-lived host caches on every deploy.
build <- format(Sys.time(), "%Y%m%d%H%M%S")
invisible(file.copy(list.files(site_src, full.names = TRUE), site_out,
                    recursive = TRUE, overwrite = TRUE))
index_html <- gsub("__BUILD__", build,
                   readLines(file.path(site_src, "index.html")))

if (channel == "beta") {
  viewport <- grep("name=\"viewport\"", index_html, fixed = TRUE)
  if (length(viewport) != 1) stop("index.html has no single viewport line.")
  index_html <- append(index_html,
                       "<meta name=\"robots\" content=\"noindex, nofollow\">",
                       after = viewport)
  writeLines(c("User-agent: *", "Disallow: /"), paste0(site_out, "robots.txt"))
}

writeLines(index_html, paste0(site_out, "index.html"))

# list.files() skips dotfiles at the top of site/, but the copy above descends
# into assets/ as whole directories, so macOS's .DS_Store rides along and is
# published. Dropped here rather than filtered on the way in, because the trap
# is anything hidden, not that one filename.
copied <- list.files(site_out, recursive = TRUE, all.files = TRUE,
                     full.names = TRUE)
unlink(copied[startsWith(basename(copied), ".")])

# Guarded rather than trusted: nothing under site/ should be R or survey data,
# but a file saved there by mistake would otherwise become readable on a public
# URL.
published_source <- list.files(site_out, pattern = "\\.([Rr]|csv|Rmd)$",
                               recursive = TRUE)

if (length(published_source) > 0) {
  print(published_source)
  stop("Files above reached the built site - they must not be uploaded.")
}

required <- c("index.html", "engine.js", "engine.css", "config.json",
              "data/questions.json", "data/map/region_values.json",
              "data/map/locations.json", "data/geo/regions.geojson",
              "data/geo/counties.geojson", "data/meta.json",
              "assets/vendor/leaflet.js", "assets/vendor/chart.umd.min.js")
absent <- required[!file.exists(paste0(site_out, required))]

if (length(absent) > 0) {
  print(absent)
  stop("Files above are missing from the built site.")
}

size_mb <- sum(file.size(list.files(site_out, recursive = TRUE,
                                    full.names = TRUE))) / 1024^2
message("Site written to ", site_out)
message("  build ", build, ", ", length(q_files), " questions, ",
        length(topics), " key topics, ", length(catalog), " mapped measures, ",
        round(size_mb, 1), " MB total")
