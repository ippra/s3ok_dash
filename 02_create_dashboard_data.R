library(tidyverse)
library(srvyr)
library(sf)
library(jsonlite)

source(here::here("00_paths.R"))
source(here::here("helpers", "wording.R"))
source(here::here("helpers", "splits.R"))
source(here::here("helpers", "rcode.R"))

# Dashboard Data ---------------------------------------------------------------
# Every number the dashboard shows is computed here and nowhere else. 03 reads
# what this writes and assembles the site around it without calculating
# anything, so the site cannot disagree with what was computed.
#
# Reads the eight public wave files and the variable reference. Writes
# outputs/02_dashboard_data/:
#
#   questions.json   the question index the explorer's search and browser read
#   q/               one file per question: the distribution under every split
#   rcode/           one file per question: the R that rebuilds each chart
#   panel/           for a question asked in several waves: each respondent's
#                    answers across them
#   panel_rcode/     the R that rebuilds each of those charts
#   topics/          the five key-topic batteries, under every split
#   narratives/      Wave 1's open-ended answers on water, land, infrastructure
#   regions.geojson  the five survey regions
#   locations.json   approximate respondent locations for the map
#   respondents.json respondent counts for the landing and About pages
#   splits.json      the split roster 03 hands to the front end
#
# Percentages are unweighted: the public files carry no survey weights. The
# survey is a panel, so one person can answer the same question in several
# waves. Estimates are shares of responses, and every interval comes from a
# design clustered on the panelist (`ids = p_id`), which widens it for the
# repeated answers rather than treating them as independent.
#
# Takes ten to twenty-five minutes, most of it the srvyr calls (one per
# question per split) and running a sample of the generated scripts against
# their charts.

unlink(dashboard_data, recursive = TRUE)
for (d in c("q", "rcode", "panel", "panel_rcode", "topics", "narratives")) {
  dir.create(paste0(dashboard_data, d), recursive = TRUE, showWarnings = FALSE)
}

wjson <- function(x, path) {
  write_json(x, paste0(dashboard_data, path), auto_unbox = TRUE, na = "null",
             null = "null", digits = NA)
}

# A group with fewer respondents than this on a question is not charted: a
# percentage of eight people reads as a finding and is not one. The caption
# names what was left out.
min_group_n <- 20

# Values the wave files use for "no answer" that are not NA. The fuel-ranking
# battery writes a dash for an item the respondent left unranked.
missing_codes <- "-"

# Responses --------------------------------------------------------------------
# Read as character throughout. A question asked in one wave is empty in the
# others, and a column empty for its first thousand rows is guessed logical,
# which turns every real value after it into NA.
missing_files <- waves$file[!file.exists(paste0(survey_files, waves$file))]

if (length(missing_files) > 0) {
  print(missing_files)
  stop("Wave files above are not in ", survey_files)
}

# Columns only the unreleased files carry. Checked so that pointing a wave at
# the wrong file stops the build instead of publishing from it.
private_columns <- c(
  "confirm_fname", "confirm_lname", "confirm_address", "confirm_phone",
  "confirm_email", "Latitude", "Longitude"
)

read_wave <- function(wave, file) {
  wave_data <- read_csv(
    paste0(survey_files, file),
    col_types = cols(.default = col_character())
  )

  if (nrow(problems(wave_data)) > 0) {
    print(problems(wave_data))
    stop(file, " did not parse cleanly - rows above would be read wrongly.")
  }

  if (any(private_columns %in% names(wave_data))) {
    stop(file, " carries contact or location columns - it is not a public ",
         "wave file.")
  }

  wave_name <- unique(wave_data$wave_id)

  if (length(wave_name) != 1 ||
      !str_detect(wave_name, paste0("Wave ", wave, "\\b"))) {
    stop(file, " is listed as wave ", wave, " but its wave_id is `",
         paste(wave_name, collapse = "`, `"), "`.")
  }

  wave_data |> mutate(wave = wave)
}

responses_data <- map2(waves$wave, waves$file, read_wave) |> bind_rows()

if (anyDuplicated(responses_data[c("p_id", "wave")]) > 0) {
  stop("A panelist appears twice in one wave - responses would be counted ",
       "twice.")
}

# One age in the files is 69.5, so the check is for a number, not a whole one.
bad_ages <- responses_data$age[
  !is.na(responses_data$age) &
    !str_detect(responses_data$age, "^\\d+(\\.\\d+)?$")
]

if (length(bad_ages) > 0) {
  print(unique(bad_ages))
  stop("Ages above are not numbers - the age split would drop them.")
}

# end_datetime is seconds since 1970. The wave names the files carry do not
# always match the season of fielding (Wave 1 is "Summer 2021" and ran in
# February and March), so the dates shown on the site are read from here.
responses_data <- responses_data |>
  mutate(
    end_date = as.Date(as.POSIXct(
      as.numeric(end_datetime), origin = "1970-01-01", tz = "America/Chicago"
    )),
    WAVE = paste("Wave", wave)
  )

if (anyNA(responses_data$end_date)) {
  stop("Some responses have no completion time - field dates would be wrong.")
}

message("Responses: ", nrow(responses_data), " from ",
        n_distinct(responses_data$p_id), " panelists in ", nrow(waves),
        " waves")

# Splits -----------------------------------------------------------------------
# Each split's own expression (helpers/splits.R), evaluated against the wave
# data: the same text a downloaded script carries.
absent_sources <- setdiff(
  unlist(map(splits, "sources")), names(responses_data)
)

if (length(absent_sources) > 0) {
  print(absent_sources)
  stop("Columns above are named by a split and are not in the wave files.")
}

for (s in splits) {
  if (is.null(s$expr)) next
  responses_data[[s$id]] <- eval(
    parse(text = paste(s$expr, collapse = "\n")), responses_data
  )
}

for (s in splits) {
  unlisted <- setdiff(na.omit(unique(responses_data[[s$id]])), s$levels)

  if (length(unlisted) > 0) {
    print(unlisted)
    stop("Groups above are in the data for ", s$id, " and not in its levels ",
         "- they would be drawn in no fixed order.")
  }
}

split_levels <- map(splits, "levels")
split_columns <- names(splits)

wjson(
  c(
    list(list(id = "All", label = "Everyone", phrase = NULL, levels = "All")),
    unname(map(splits, function(s) {
      list(id = s$id, label = s$label, phrase = s$phrase,
           levels = as.list(s$levels))
    }))
  ),
  "splits.json"
)

# Questions --------------------------------------------------------------------
reference_data <- read_csv(
  variable_reference,
  col_types = cols(.default = col_character())
)
topics_data <- read_csv(
  topics_reference,
  col_types = cols(.default = col_character())
)

if (anyDuplicated(reference_data$variable) > 0) {
  print(reference_data$variable[duplicated(reference_data$variable)])
  stop("Variables above are listed twice in the variable reference.")
}

absent_variables <- setdiff(reference_data$variable, names(responses_data))

if (length(absent_variables) > 0) {
  print(absent_variables)
  stop("Variables above are in the reference and in no wave file.")
}

unknown_topics <- setdiff(reference_data$topic, topics_data$topic)

if (length(unknown_topics) > 0) {
  print(unknown_topics)
  stop("Topics above are used in the reference and not listed in topics.csv.")
}

# "1 = No risk | 2 = Low risk" as a table of values and labels.
option_labels <- function(x) {
  parts <- str_split(x, fixed(" | "))[[1]]
  matches <- str_match(parts, "^\\s*(.+?)\\s*=\\s*(.*)$")
  tibble(value = matches[, 2], label = matches[, 3])
}

reference_data <- reference_data |>
  mutate(
    options = map(response_options, option_labels),
    question = str_squish(paste(coalesce(question_intro, ""), question_text))
  )

unparsed_data <- reference_data |>
  filter(map_lgl(options, function(o) nrow(o) == 0 || anyNA(o)))

if (nrow(unparsed_data) > 0) {
  print(unparsed_data$variable)
  stop("Response options above did not parse as `value = label | ...`.")
}

# Every answer in the data has to be a documented option. An undocumented
# code would be drawn as a bar labelled with a number nobody can read.
undocumented_data <- reference_data |>
  mutate(
    codes = map2_chr(variable, options, function(v, o) {
      seen <- na.omit(unique(responses_data[[v]]))
      paste(setdiff(seen, c(o$value, missing_codes)), collapse = ", ")
    })
  ) |>
  filter(codes != "") |>
  select(variable, codes)

if (nrow(undocumented_data) > 0) {
  print(undocumented_data, n = Inf)
  stop("Variables above take values their response options do not list.")
}

# Whether a question's options run in an order, so that an average answer
# means something. Decided per question in the reference: a scale from no risk
# to extreme risk is ordered; a list of parties, or a scale with "Don't know"
# among its options, is not.
bad_order <- setdiff(reference_data$scale_order, c("ordered", "unordered"))

if (length(bad_order) > 0) {
  print(reference_data$variable[reference_data$scale_order %in% bad_order])
  stop("Questions above have a scale_order that is neither `ordered` nor ",
       "`unordered`.")
}

message("Questions: ", nrow(reference_data), " across ",
        n_distinct(reference_data$topic), " topics")

# Split-Sample Questions -------------------------------------------------------
# Some questions were asked in more than one wording, chosen at random and
# recorded in a randomization column. Those are estimated one version at a
# time and carry a version menu: pooling the versions would average across
# the difference the experiment was testing.
question_arms_data <- read_csv(
  question_arms_reference,
  col_types = cols(.default = col_character())
)
arms_data <- read_csv(
  arms_reference,
  col_types = cols(arm_order = col_integer(), .default = col_character())
) |>
  arrange(arm_variable, arm_order)

unpaired <- setdiff(question_arms_data$variable, reference_data$variable)

if (length(unpaired) > 0) {
  print(unpaired)
  stop("Questions above are paired with a randomizer and are not charted.")
}

for (v in unique(question_arms_data$arm_variable)) {
  if (!v %in% names(responses_data)) {
    stop("`", v, "` is declared in question_arms.csv and is not a column in ",
         "the wave files.")
  }

  declared <- arms_data$value[arms_data$arm_variable == v]
  unlisted <- setdiff(na.omit(unique(responses_data[[v]])), declared)

  if (length(declared) < 2 || length(unlisted) > 0) {
    print(unlisted)
    stop("`", v, "` needs at least two versions in arms.csv, and every value ",
         "it takes in the data listed there.")
  }
}

arm_of <- setNames(question_arms_data$arm_variable,
                   question_arms_data$variable)

# Percentages ------------------------------------------------------------------
# Runs of consecutive numbers as "1-3, 5", for waves and for years.
number_runs <- function(x) {
  y <- sort(unique(as.integer(x)))
  ends <- c(which(diff(y) != 1), length(y))
  starts <- c(1, head(ends, -1) + 1)
  runs <- if_else(y[starts] == y[ends], as.character(y[starts]),
                  paste0(y[starts], "-", y[ends]))
  paste(runs, collapse = ", ")
}

# The rows a chart under one split rests on: answered, in a group, and in a
# group large enough to chart.
split_rows <- function(narrow_data, grouping) {
  kept_data <- narrow_data |>
    mutate(group = if (grouping == "All") "All" else .data[[grouping]]) |>
    drop_na(resp, group)
  group_counts <- table(kept_data$group)
  small <- group_counts[group_counts < min_group_n]
  list(
    rows = kept_data |> filter(!group %in% names(small)),
    small = small
  )
}

distribution <- function(kept_data, grouping, option_values) {
  if (nrow(kept_data) == 0) return(NULL)
  levels <- if (grouping == "All") "All" else split_levels[[grouping]]

  # proportion = TRUE gives logit intervals, which stay inside 0 and 100. It
  # warns on a cell at exactly 0 or 100 percent, where the interval is not
  # defined and is written as missing.
  suppressWarnings(
    kept_data |>
      as_survey_design(ids = p_id) |>
      group_by(group, resp) |>
      summarize(p = survey_prop(proportion = TRUE, vartype = "ci"),
                .groups = "drop")
  ) |>
    mutate(across(c(p, p_low, p_upp), function(x) round(x * 100, 2))) |>
    arrange(match(group, levels), match(resp, option_values))
}

# The respondent counts the caption quotes: the rows the chart rests on
# rather than the whole wave.
respondent_summary <- function(kept, grouping) {
  kept_data <- kept$rows
  if (nrow(kept_data) == 0) return(NULL)
  levels <- if (grouping == "All") "All" else split_levels[[grouping]]
  counts <- table(factor(kept_data$group, levels = levels))
  counts <- counts[counts > 0]
  list(
    n = nrow(kept_data),
    people = n_distinct(kept_data$p_id),
    n_waves = n_distinct(kept_data$wave),
    waves = number_runs(kept_data$wave),
    years = number_runs(format(kept_data$end_date, "%Y")),
    smallest = names(counts)[which.min(counts)],
    smallest_n = as.integer(min(counts)),
    group_n = as.list(setNames(as.integer(counts), names(counts))),
    not_shown = unname(map2(names(kept$small), as.integer(kept$small),
                            function(g, n) list(group = g, n = n)))
  )
}

# Everything one version of one question needs: its rows and summary under
# every split, and the script that rebuilds each.
estimate_question <- function(narrow_data, q, arm = NULL) {
  option_values <- q$options[[1]]$value
  out <- list(splits = list(), summaries = list(), scripts = list())
  wave_numbers <- sort(unique(narrow_data$wave[!is.na(narrow_data$resp)]))
  title <- readable_wording(
    q$question,
    arm_variable = arm$variable,
    arm_slot = arm$wording
  )

  for (g in split_ids) {
    kept <- split_rows(narrow_data, g)
    rows <- distribution(kept$rows, g, option_values)
    if (is.null(rows)) next
    out$splits[[g]] <- rows
    out$summaries[[g]] <- respondent_summary(kept, g)
    out$scripts[[g]] <- r_script(
      question = title,
      variable = q$variable,
      wave_numbers = wave_numbers,
      wave_files = waves$file[match(wave_numbers, waves$wave)],
      split = if (g == "All") NULL else splits[[g]],
      level_values = option_values,
      level_labels = q$options[[1]]$label,
      missing_codes = if (any(narrow_data$raw %in% missing_codes)) {
        missing_codes
      } else {
        character(0)
      },
      min_group_n = min_group_n,
      arm_column = arm$variable,
      arm_value = arm$value,
      arm_label = arm$label
    )
  }
  out
}

# Which scripts are run and compared with what is being published. Everyone
# for every question (and every version), plus one other split per question,
# rotating through the roster so each split's expression is exercised about
# thirty times across different waves and scales. Running all of them would
# take most of an hour for no more coverage than that.
verified <- 0L
verify_question <- function(estimates, q, index, label) {
  options <- q$options[[1]]
  rotating <- split_columns[(index - 1) %% length(split_columns) + 1]

  for (g in intersect(c("All", rotating), names(estimates$scripts))) {
    verify_r_code(estimates$scripts[[g]], estimates$splits[[g]], options,
                  paste(label, g))
    verified <<- verified + 1L
  }
}

# The Question Loop ------------------------------------------------------------
wave_runs_label <- function(wave_numbers) {
  paste0(if (length(wave_numbers) == 1) "Wave " else "Waves ",
         str_replace_all(number_runs(wave_numbers), "-", "–"))
}

question_index <- vector("list", nrow(reference_data))
started <- Sys.time()

for (i in seq_len(nrow(reference_data))) {
  q <- reference_data[i, ]
  arm_variable <- unname(arm_of[q$variable])
  armed <- !is.na(arm_variable)

  narrow_data <- responses_data |>
    select(p_id, wave, end_date, raw = all_of(q$variable),
           all_of(split_columns),
           any_of(c(arm = if (armed) arm_variable))) |>
    mutate(resp = if_else(raw %in% missing_codes, NA_character_, raw))

  wave_numbers <- sort(unique(narrow_data$wave[!is.na(narrow_data$resp)]))

  if (length(wave_numbers) == 0) {
    stop("`", q$variable, "` has no answers in any wave.")
  }

  if (armed) {
    roster_data <- arms_data |> filter(arm_variable == !!arm_variable)
    answered <- roster_data$value[map_lgl(roster_data$value, function(v) {
      any(!is.na(narrow_data$resp) & narrow_data$arm %in% v)
    })]

    if (length(answered) < 2) {
      stop("`", q$variable, "` is paired with `", arm_variable, "` but ",
           "fewer than two versions were answered.")
    }

    roster_data <- roster_data |> filter(value %in% answered)
    by_arm <- map(seq_len(nrow(roster_data)), function(k) {
      arm <- list(variable = arm_variable, value = roster_data$value[k],
                  label = roster_data$label[k],
                  wording = roster_data$wording[k])
      estimates <- estimate_question(
        narrow_data |> filter(arm == !!arm$value), q, arm
      )
      verify_question(estimates, q, i,
                      paste0(q$variable, " [", arm$value, "]"))
      estimates
    })
    names(by_arm) <- roster_data$value
    splits_out <- map(by_arm, "splits")
    summaries_out <- map(by_arm, "summaries")
    scripts_out <- map(by_arm, "scripts")
  } else {
    estimates <- estimate_question(narrow_data, q)
    verify_question(estimates, q, i, q$variable)
    splits_out <- estimates$splits
    summaries_out <- estimates$summaries
    scripts_out <- estimates$scripts
  }

  shared <- list(
    id = q$variable,
    variable = q$variable,
    topic = q$topic,
    asked = wave_runs_label(wave_numbers),
    waves = as.list(wave_numbers),
    question = q$question,
    question_intro = q$question_intro,
    question_text = q$question_text,
    kind = if (armed) "Experiment" else "Standard"
  )

  # `arms` is the signal the front end reads for a split-sample question, so
  # it is absent, not empty, everywhere else.
  question_file <- c(
    shared,
    list(
      options = q$options[[1]],
      has_r_code = TRUE
    ),
    if (armed) {
      list(
        arms = roster_data |> select(id = value, label),
        arm_prompt = roster_data$prompt[1]
      )
    },
    list(splits = splits_out, summaries = summaries_out)
  )

  wjson(question_file, paste0("q/", q$variable, ".json"))
  wjson(scripts_out, paste0("rcode/", q$variable, ".json"))
  question_index[[i]] <- shared

  if (i %% 60 == 0) {
    cat(i, "of", nrow(reference_data), "questions,",
        round(as.numeric(difftime(Sys.time(), started, units = "mins")), 1),
        "minutes\n")
  }
}

wjson(question_index, "questions.json")
message("Questions written: ", length(question_index), "; ", verified,
        " generated scripts run and matched to their charts")

# Panel Paths ------------------------------------------------------------------
# For a question asked in more than one wave, the answers each respondent gave
# across those waves, so the page can draw a line per person. The sample is
# balanced first: only respondents who answered the question in every wave
# that asked it are kept, so every line runs the full width and a change in
# the picture is a change in answers rather than in who took part.
#
# The lines can be colored by any split but the wave. A person's group can
# change from wave to wave (age, party), so each keeps the group they were in
# at the first wave that asked the question. A group with too few respondents
# to chart is left out of that split, as it is under the bars.
#
# Where the options are ordered, the average answer in each wave is computed
# for every group, on the same balanced sample, as a position among the
# options (1 for the first), which is where the page draws it.
#
# Rows are distinct combinations of an answer sequence and groups, with the
# number of people who share each, and carry no identifier. Every column here
# is in the public wave files beside p_id, so nothing is released that those
# files do not already hold.
panel_splits <- setdiff(split_columns, "WAVE")
panel_ids <- character(0)
panel_verified <- 0L

for (i in seq_len(nrow(reference_data))) {
  q <- reference_data[i, ]
  # A split-sample question was asked in one wave, and a path across versions
  # would not be a path across time.
  if (!is.na(arm_of[q$variable])) next

  answers_data <- responses_data |>
    select(p_id, wave, end_date, resp = all_of(q$variable),
           all_of(panel_splits)) |>
    mutate(resp = if_else(resp %in% missing_codes, NA_character_, resp)) |>
    drop_na(resp)
  wave_numbers <- sort(unique(answers_data$wave))
  if (length(wave_numbers) < 2) next

  balanced_data <- answers_data |>
    filter(n() == length(wave_numbers), .by = p_id) |>
    arrange(p_id, wave)
  n_balanced <- n_distinct(balanced_data$p_id)
  if (n_balanced < min_group_n) next

  if (nrow(balanced_data) != n_balanced * length(wave_numbers)) {
    stop("The balanced panel for `", q$variable, "` is not one row per ",
         "respondent per wave.")
  }

  # One row per person: their path, and their groups at the first wave.
  person_data <- balanced_data |>
    summarize(
      path = paste(resp, collapse = ","),
      same = n_distinct(resp) == 1,
      across(all_of(panel_splits), first),
      .by = p_id
    )

  group_n <- list()
  not_shown <- list()

  for (s in panel_splits) {
    counts <- table(factor(person_data[[s]], levels = split_levels[[s]]))
    counts <- counts[counts > 0]
    small <- counts[counts < min_group_n]
    person_data[[s]][person_data[[s]] %in% names(small)] <- NA
    shown <- counts[counts >= min_group_n]
    group_n[[s]] <- as.list(setNames(as.integer(shown), names(shown)))
    not_shown[[s]] <- unname(map2(names(small), as.integer(small),
                                  function(g, n) list(group = g, n = n)))
  }

  paths_data <- person_data |>
    count(path, across(all_of(panel_splits)))
  option_values <- q$options[[1]]$value
  ordered_scale <- q$scale_order == "ordered"

  # Each group's average position in each wave, with every person counted
  # under the group their line is drawn in.
  wave_means <- function(g) {
    grouped_data <- balanced_data |>
      select(p_id, wave, resp) |>
      inner_join(
        person_data |>
          transmute(p_id, group = if (g == "All") "All" else .data[[g]]) |>
          drop_na(group),
        by = "p_id"
      ) |>
      summarize(mean = round(mean(match(resp, option_values)), 3),
                .by = c(group, wave)) |>
      arrange(group, wave)
    map(split(grouped_data$mean, grouped_data$group), as.list)
  }
  means <- if (ordered_scale) {
    map(setNames(c("All", panel_splits), c("All", panel_splits)), wave_means)
  }

  # The script behind each coloring, and a check that two of them (Everyone
  # and one rotating split) rebuild the paths being published.
  scripts <- map(setNames(c("All", panel_splits), c("All", panel_splits)),
                 function(g) {
    r_paths_script(
      question = readable_wording(q$question),
      variable = q$variable,
      wave_numbers = wave_numbers,
      wave_files = waves$file[match(wave_numbers, waves$wave)],
      split = if (g == "All") NULL else splits[[g]],
      level_values = option_values,
      level_labels = q$options[[1]]$label,
      missing_codes = if (any(responses_data[[q$variable]] %in%
                              missing_codes)) {
        missing_codes
      } else {
        character(0)
      },
      min_group_n = min_group_n,
      with_means = ordered_scale
    )
  })
  rotating <- panel_splits[(i - 1) %% length(panel_splits) + 1]

  for (g in c("All", rotating)) {
    expect_data <- if (g == "All") {
      paths_data |> transmute(group = "All", path, n)
    } else {
      paths_data |>
        transmute(group = .data[[g]], path, n) |>
        drop_na(group)
    }
    if (nrow(expect_data) == 0) next
    verify_r_paths(scripts[[g]], expect_data, option_values,
                   paste(q$variable, "paths", g),
                   expect_means = if (ordered_scale) means[[g]])
    panel_verified <- panel_verified + 1L
  }

  wjson(
    list(
      id = q$variable,
      waves = as.list(wave_numbers),
      asked = wave_runs_label(wave_numbers),
      years = number_runs(format(balanced_data$end_date, "%Y")),
      n = n_balanced,
      # How many gave one answer throughout, for the caption.
      same_n = sum(person_data$same),
      splits = as.list(panel_splits),
      # Null where the options have no order to average over.
      means = means,
      group_n = group_n,
      not_shown = not_shown,
      # `g` is each split's group as a position in that split's levels,
      # counted from zero, in the order of `splits`; null where the person
      # is in no charted group.
      paths = pmap(paths_data, function(path, n, ...) {
        groups <- list(...)
        list(
          path = path, n = n,
          g = unname(map(panel_splits, function(s) {
            match(groups[[s]], split_levels[[s]]) - 1L
          }))
        )
      })
    ),
    paste0("panel/", q$variable, ".json")
  )
  wjson(scripts, paste0("panel_rcode/", q$variable, ".json"))
  panel_ids <- c(panel_ids, q$variable)
}

wjson(as.list(panel_ids), "panel/index.json")
message("Panel paths written: ", length(panel_ids), " questions asked in ",
        "more than one wave; ", panel_verified, " generated scripts run and ",
        "matched")

# Key Topics -------------------------------------------------------------------
# Five batteries shown whole: every item of a battery
# on one chart, as a mean or a share, under every split. The item labels are
# declared here because several of these questions carry no item of their own
# in the reference (long-term drought is its own question).
hazard_items <- c(
  tornado = "Tornadoes", hail = "Hail", wind = "High winds",
  lightning = "Lightning", flood = "Flooding", snow_ice = "Snow and ice",
  flash_drought = "Flash drought", pluvial = "Pluvials",
  heat_wave = "Heat waves", cold_spell = "Cold spells",
  long_drought = "Long-term drought", wildfire = "Wildfires",
  earthquake = "Earthquakes"
)
hazard_set <- function(prefix) {
  setNames(hazard_items, paste0(prefix, "_", names(hazard_items)))
}

topic_sets <- list(
  list(
    id = "priorities", group = "Policy priorities",
    label = "What needs the most attention",
    kind = "top",
    prompt = paste(
      "If you were advising the scientists and policymakers who are working",
      "on this project, which of the following would you tell them require",
      "the most attention? Please rank the items from one (most attention)",
      "to seven (least attention)."
    ),
    value_label = "Ranked first (%)",
    items = c(
      rank_water_availability = "Water availability",
      rank_water_quality = "Water quality",
      rank_water_cost = "Water cost",
      rank_land_wildlife = "Wildlife habitat",
      rank_land_soil = "Soil quality",
      rank_infra_electricity = "Electricity infrastructure",
      rank_infra_transportation = "Transportation infrastructure"
    )
  ),
  list(
    id = "risk", group = "Weather and climate",
    label = "Perceived risk of weather and climate hazards",
    kind = "mean",
    prompt = "How do you rate the risk of these hazards to people in Oklahoma?",
    scale = "1 = No risk, 5 = Extreme risk",
    value_label = "Mean rating (1–5)",
    items = hazard_set("risk")
  ),
  list(
    id = "experience", group = "Weather and climate",
    label = "Hazards experienced in the last six months",
    kind = "share",
    prompt = "Did you experience any of these hazards in the last 6 months?",
    value_label = "Answering yes (%)",
    items = hazard_set("experience")
  ),
  list(
    id = "future", group = "Weather and climate",
    label = "Expected change in hazard risk over the next 25 years",
    kind = "mean",
    prompt = paste(
      "When you think about the next 25 years in Oklahoma, do you think the",
      "risk (frequency and severity) of these hazards will increase,",
      "decrease, or stay about the same?"
    ),
    scale = "1 = Significantly decrease, 5 = Significantly increase",
    value_label = "Mean rating (1–5)",
    items = hazard_set("future")
  ),
  list(
    id = "trust", group = "Trust",
    label = "Trust in sources of information",
    kind = "mean",
    prompt = paste(
      "Solving problems as a group or community can be contentious and",
      "technically complex, so getting information you can trust is",
      "important. How much do you trust information from the following",
      "groups and organizations?"
    ),
    scale = "1 = No trust, 5 = Complete trust",
    value_label = "Mean rating (1–5)",
    items = c(
      trust_university = "University scientists",
      trust_nonprofit = "Nonprofit research organizations",
      trust_agencies = paste(
        "State and local agencies that regulate water, land, and",
        "infrastructure resources"
      ),
      trust_private = paste(
        "Private companies whose operations use water, land, and",
        "infrastructure resources"
      ),
      trust_policy = "State and local policymakers and elected officials",
      trust_tribe = "Tribal leaders and governing bodies"
    )
  )
)

topic_variables <- unlist(map(topic_sets, function(x) names(x$items)))
absent_topic_variables <- setdiff(topic_variables, names(responses_data))

if (length(absent_topic_variables) > 0) {
  print(absent_topic_variables)
  stop("Key-topic items above are not columns in the wave files.")
}

# One row per response per item. A `top` set is different: its one "item" per
# response is whichever item that respondent ranked first, so it is a
# distribution over items rather than a value for each.
topic_long <- function(set) {
  items <- names(set$items)
  wide_data <- responses_data |>
    select(p_id, wave, end_date, all_of(split_columns), all_of(items)) |>
    mutate(across(all_of(items), as.numeric))

  if (set$kind == "top") {
    firsts <- rowSums(wide_data[items] == 1, na.rm = TRUE)
    message("Priorities: ", sum(firsts != 1), " responses rank no item or ",
            "more than one item first and are left out")
    return(
      wide_data |>
        filter(firsts == 1) |>
        pivot_longer(all_of(items), names_to = "variable") |>
        filter(value == 1) |>
        mutate(item = variable, value = 1)
    )
  }

  wide_data |>
    pivot_longer(all_of(items), names_to = "variable") |>
    drop_na(value) |>
    mutate(item = variable)
}

topic_estimates <- function(long_data, set, grouping) {
  levels <- if (grouping == "All") "All" else split_levels[[grouping]]
  kept_data <- long_data |>
    mutate(group = if (grouping == "All") "All" else .data[[grouping]]) |>
    drop_na(group)

  design <- kept_data |> as_survey_design(ids = p_id)

  est_data <- suppressWarnings(
    if (set$kind == "top") {
      design |>
        group_by(group, item) |>
        summarize(v = survey_prop(proportion = TRUE, vartype = "ci"),
                  n = unweighted(n()), .groups = "drop") |>
        # The base of a share is the group, not the cell.
        mutate(n = sum(n), .by = group)
    } else if (set$kind == "share") {
      design |>
        group_by(group, item) |>
        summarize(v = survey_mean(value, proportion = TRUE, vartype = "ci"),
                  n = unweighted(n()), .groups = "drop")
    } else {
      design |>
        group_by(group, item) |>
        summarize(v = survey_mean(value, vartype = "ci"),
                  n = unweighted(n()), .groups = "drop")
    }
  )

  scale <- if (set$kind == "mean") 1 else 100
  est_data <- est_data |>
    mutate(across(c(v, v_low, v_upp), function(x) round(x * scale, 2)))

  small_data <- est_data |> filter(n < min_group_n) |> distinct(group, n)
  shown_data <- est_data |>
    filter(n >= min_group_n) |>
    arrange(match(group, levels), match(item, names(set$items))) |>
    transmute(group, variable = item, item = unname(set$items[item]),
              value = v, low = v_low, upp = v_upp, n)

  respondents_data <- kept_data |>
    filter(group %in% shown_data$group) |>
    distinct(p_id, wave, end_date, group)
  counts <- table(factor(respondents_data$group, levels = levels))
  counts <- counts[counts > 0]

  list(
    rows = shown_data,
    summary = list(
      n = nrow(respondents_data),
      people = n_distinct(respondents_data$p_id),
      n_waves = n_distinct(respondents_data$wave),
      waves = number_runs(respondents_data$wave),
      years = number_runs(format(respondents_data$end_date, "%Y")),
      smallest = names(counts)[which.min(counts)],
      smallest_n = as.integer(min(counts)),
      group_n = as.list(setNames(as.integer(counts), names(counts))),
      not_shown = unname(map2(small_data$group, small_data$n, function(g, n) {
        list(group = g, n = n)
      }))
    )
  )
}

for (set in topic_sets) {
  long_data <- topic_long(set)
  by_split <- map(setNames(split_ids, split_ids), function(g) {
    topic_estimates(long_data, set, g)
  })

  # Items in the order Everyone puts them, highest first, under every split,
  # so changing the split recolors the chart rather than reshuffling it.
  everyone_data <- by_split$All$rows |> arrange(desc(value))
  item_order <- everyone_data$variable

  item_waves <- map_chr(item_order, function(v) {
    wave_runs_label(sort(unique(long_data$wave[long_data$variable == v])))
  })

  wjson(
    list(
      id = set$id, group = set$group, label = set$label, kind = set$kind,
      prompt = set$prompt, scale = set$scale, value_label = set$value_label,
      items = pmap(
        list(item_order, unname(set$items[item_order]), item_waves),
        function(v, label, asked) {
          list(variable = v, label = label, asked = asked,
               listed = v %in% reference_data$variable)
        }
      ),
      splits = map(by_split, function(x) {
        x$rows |> arrange(match(variable, item_order))
      }),
      summaries = map(by_split, "summary")
    ),
    paste0("topics/", set$id, ".json")
  )
}

message("Key topics written: ", length(topic_sets))

# Narratives -------------------------------------------------------------------
# Wave 1 asked respondents who had a concern to describe the problem, who or
# what is causing it and what might fix it, for water, land and
# infrastructure. They are published as written. The columns are in the public
# wave file, so nothing here is released for the first time, but an address or
# a phone number typed into an answer would be, so the text is checked first.
narrative_sets <- list(
  list(id = "water", label = "Water resources", stem = "water"),
  list(id = "land", label = "Land resources", stem = "land"),
  list(id = "infrastructure", label = "Infrastructure", stem = "infra")
)

contact_pattern <- paste0(
  "[[:alnum:]._-]+@[[:alnum:].-]+\\.[a-z]{2,}",
  "|\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}"
)

for (set in narrative_sets) {
  columns <- paste0(c("problem_", "problem_cause_", "problem_solve_"),
                    set$stem)
  narrative_data <- responses_data |>
    select(wave, end_date, region = REGION, problem = all_of(columns[1]),
           cause = all_of(columns[2]), solve = all_of(columns[3])) |>
    mutate(across(c(problem, cause, solve), str_squish)) |>
    filter(!is.na(problem), problem != "")

  contact_data <- narrative_data |>
    filter(if_any(c(problem, cause, solve),
                  function(x) str_detect(coalesce(x, ""), contact_pattern)))

  if (nrow(contact_data) > 0) {
    print(contact_data)
    stop("Answers above look like they contain an email address or a phone ",
         "number - they would be published.")
  }

  if (n_distinct(narrative_data$wave) != 1) {
    stop("Narratives for ", set$id, " span more than one wave - the page ",
         "describes them as one.")
  }

  wjson(
    list(
      id = set$id, label = set$label,
      wave = wave_runs_label(unique(narrative_data$wave)),
      n = nrow(narrative_data),
      rows = narrative_data |>
        arrange(end_date) |>
        transmute(problem, cause, solve, region,
                  month = format(end_date, "%B %Y"))
    ),
    paste0("narratives/", set$id, ".json")
  )
  message("Narratives, ", set$label, ": ", nrow(narrative_data))
}

# Regions ----------------------------------------------------------------------
# The five survey regions, dissolved from the 2023 county boundaries by the
# county-to-region table. Built from counties rather than read from the older
# region shapefile so region borders sit exactly on the county lines drawn
# under them.
counties_sf <- read_sf(counties_reference)
county_regions_data <- read_csv(
  county_regions_reference,
  col_types = cols(.default = col_character())
) |>
  # The Census spells it "Le Flore".
  mutate(County = if_else(County == "LeFlore", "Le Flore", County))

unassigned <- setdiff(counties_sf$NAME, county_regions_data$County)
unknown_counties <- setdiff(county_regions_data$County, counties_sf$NAME)

if (length(unassigned) > 0 || length(unknown_counties) > 0) {
  print(c(unassigned, unknown_counties))
  stop("Counties above do not match between the boundary file and the ",
       "county-to-region table - a region would be drawn with a hole.")
}

unknown_regions <- setdiff(county_regions_data$Region,
                           split_levels$REGION)

if (length(unknown_regions) > 0) {
  print(unknown_regions)
  stop("Regions above are in the county table and not in the survey data.")
}

# st_make_valid() first: the boundary file has rings the spherical union
# refuses as they come.
counties_sf <- counties_sf |>
  st_make_valid() |>
  left_join(county_regions_data, by = c("NAME" = "County")) |>
  select(COUNTY = NAME, REGION = Region)

regions_sf <- counties_sf |>
  group_by(REGION) |>
  summarize(geometry = st_union(geometry), .groups = "drop")

unlink(paste0(dashboard_data, c("regions.geojson", "counties.geojson")))
st_write(regions_sf, paste0(dashboard_data, "regions.geojson"),
         driver = "GeoJSON", quiet = TRUE)
st_write(counties_sf, paste0(dashboard_data, "counties.geojson"),
         driver = "GeoJSON", quiet = TRUE)

# Respondent Locations ---------------------------------------------------------
# One dot per panelist, from the shared location file, whose coordinates were
# already displaced by up to 0.01 degrees (about a kilometre) before sharing.
# Nothing more exact than that file is read. Dots carry no attribute: the map
# shows where the panel lives, not who answered what.
if (!file.exists(shared_locations)) {
  stop("The shared location file is not in data/. It is kept out of the ",
       "repository; ask the project for a copy (see README.md).")
}

locations_data <- read_csv(
  shared_locations,
  col_types = cols(p_id = col_character(), wave_id = col_character(),
                   Longitude = col_double(), Latitude = col_double())
)

unknown_panelists <- setdiff(locations_data$p_id, responses_data$p_id)

if (length(unknown_panelists) > 0) {
  stop(length(unknown_panelists), " panelists in the shared location file ",
       "are not in the public wave files.")
}

# A panelist's most recent location, and only where it falls inside the
# state: the file holds a few coordinates at (0, 0) and outside Oklahoma.
state_sf <- st_union(regions_sf)
points_sf <- locations_data |>
  drop_na(Longitude, Latitude) |>
  mutate(wave = parse_number(str_extract(wave_id, "Wave \\d+"))) |>
  slice_max(wave, n = 1, by = p_id) |>
  st_as_sf(coords = c("Longitude", "Latitude"), crs = st_crs(regions_sf))
inside <- lengths(st_intersects(points_sf, state_sf)) > 0

message("Respondent locations: ", sum(inside), " panelists mapped; ",
        sum(!inside), " outside Oklahoma and ",
        n_distinct(responses_data$p_id) - nrow(points_sf),
        " with no location are not drawn")

wjson(
  list(
    n = sum(inside),
    # Three decimals is about 100 metres, well inside the displacement.
    points = round(st_coordinates(points_sf[inside, ]), 3)
  ),
  "locations.json"
)

# Respondents ------------------------------------------------------------------
# Counts for the landing page and the About page, read off the same table the
# statistics were.
wave_counts_data <- responses_data |>
  group_by(wave) |>
  summarize(
    name = str_remove(first(wave_id), "^S3OK "),
    start = min(end_date),
    end = max(end_date),
    n = n(),
    .groups = "drop"
  )

region_counts_data <- responses_data |>
  drop_na(REGION) |>
  group_by(region = REGION) |>
  summarize(responses = n(), people = n_distinct(p_id), .groups = "drop") |>
  arrange(match(region, split_levels$REGION))

waves_per_person <- responses_data |> count(p_id) |> pull(n)

wjson(
  list(
    rows = nrow(responses_data),
    people = n_distinct(responses_data$p_id),
    questions = nrow(reference_data),
    years = range(as.integer(format(responses_data$end_date, "%Y"))),
    waves = wave_counts_data |>
      mutate(across(c(start, end), as.character)),
    regions = region_counts_data,
    all_waves = sum(waves_per_person == nrow(waves)),
    age_median = median(as.numeric(responses_data$age), na.rm = TRUE),
    female_pct = round(100 * mean(responses_data$GENDER == "Female",
                                  na.rm = TRUE)),
    min_group_n = min_group_n
  ),
  "respondents.json"
)

message("Dashboard data written to ", dashboard_data, " in ",
        round(as.numeric(difftime(Sys.time(), started, units = "mins")), 1),
        " minutes")
