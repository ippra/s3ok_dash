# Reproduction Scripts ---------------------------------------------------------
# Every chart on Explore Survey Questions carries the R that rebuilds it. This
# file holds the generator and the check that a generated script produces the
# numbers published beside it. Sourced by 02, which computes those numbers -
# the code that reproduces an estimate is written by the code that made it.
#
# One script per (question, split), not one template with placeholders. Three
# rules the generated code follows, and they are the point of it:
#
#   - no helper functions. Every step is a call the reader can run on its own.
#   - column names written where they are used, never through .data[[ ]].
#   - only the columns this chart needs - no grouping column under Everyone.
#
# The scripts read the public wave files, Public_Wave_<n>_Survey_Data.csv,
# which are what 02 reads and what a reader downloads from Dataverse.

# Literals ---------------------------------------------------------------------
r_quote <- function(x) paste0('"', gsub('([\\\\"])', '\\\\\\1', x), '"')

# Non-syntactic column names need backticks. Survey variables mostly do not,
# but this is checked rather than assumed.
r_name <- function(x) if (make.names(x) == x) x else paste0("`", x, "`")

# c("a", "b", ...) wrapped to fit. Breaks between elements only: strwrap()
# breaks at any whitespace, which would put a newline inside a response label
# and quietly change the string.
r_vec <- function(x, indent) {
  pad <- strrep(" ", indent)
  parts <- paste0(r_quote(x), c(rep(",", length(x) - 1), ""))
  lines <- character(0)
  cur <- ""
  for (piece in parts) {
    if (!nzchar(cur)) {
      cur <- piece
    } else if (indent + nchar(cur) + 1 + nchar(piece) > 78) {
      lines <- c(lines, cur)
      cur <- piece
    } else {
      cur <- paste(cur, piece)
    }
  }
  paste0("c(", paste(c(lines, cur), collapse = paste0("\n", pad)), ")")
}

# A question stem can run past 500 characters. One string literal that long is
# a line nobody can read, so it is broken into fragments.
r_title <- function(title) {
  if (nchar(title) <= 60) return(r_quote(title))
  parts <- strwrap(title, 60)
  paste0("paste(\n      ",
         paste(r_quote(parts), collapse = ",\n      "), "\n    )")
}

# The Generator ----------------------------------------------------------------
# `wave_numbers` are the waves this chart rests on, in order. `split` is an
# entry of `splits` (helpers/splits.R) or NULL for Everyone. `missing_codes` are
# values the data uses for "no answer" that are not NA. `min_group_n` is the
# size below which 02 leaves a group off the chart, so the script does too.
r_script <- function(question, variable, wave_numbers, wave_files, split,
                     level_values, level_labels, missing_codes = character(0),
                     min_group_n = 20, arm_column = NULL, arm_value = NULL,
                     arm_label = NULL) {
  obj <- paste0("wave_", wave_numbers)
  grp <- if (is.null(split)) NULL else split$id

  # A split-sample question is estimated one version at a time, so the wave is
  # filtered to the respondents who read this one before anything else happens.
  arm_filter <- if (is.null(arm_column)) "" else
    paste0(" |>\n    filter(", r_name(arm_column), " == ",
           r_quote(arm_value), ")")

  resp_expr <- if (length(missing_codes) == 0) r_name(variable) else
    paste0("if_else(", r_name(variable), " %in% ", r_vec(missing_codes, 0),
           ", NA_character_, ", r_name(variable), ")")

  # What each wave contributes: the panelist, the grouping if there is one,
  # and the answer. Nothing else.
  stack <- map2_chr(obj, wave_numbers, function(o, wave) {
    lines <- "      p_id"
    if (!is.null(grp)) {
      group_expr <- if (grp == "WAVE") r_quote(paste("Wave", wave)) else
        paste(split$expr, collapse = "\n      ")
      lines <- c(lines, paste0("      ", grp, " = ", group_expr))
    }
    lines <- c(lines, paste0("      resp = ", resp_expr))
    paste0("  ", o, arm_filter, " |>\n    transmute(\n",
           paste(lines, collapse = ",\n"), "\n    )")
  })

  drops <- c("!is.na(resp)", if (!is.null(grp)) paste0("!is.na(", grp, ")"))
  small_groups <- if (is.null(grp)) "" else paste0(
    " |>\n",
    "  # A group with fewer than ", min_group_n, " respondents on this ",
    "question is not charted.\n",
    "  filter(n() >= ", min_group_n, ", .by = ", grp, ")")

  est <- paste0(
    "# The survey is a panel, so one person can answer in several waves. The\n",
    "# design clusters on the panelist: percentages are unweighted shares of\n",
    "# responses, and the intervals allow for repeated answers.\n",
    "est <- d |>\n",
    "  as_survey_design(ids = p_id) |>\n",
    "  group_by(", paste(c(grp, "resp"), collapse = ", "), ") |>\n",
    "  summarise(\n",
    "    p = survey_prop(proportion = TRUE, vartype = \"ci\"),\n",
    "    .groups = \"drop\"\n",
    "  )\n")

  # Response codes are character, so sorting them as strings puts 10 between 1
  # and 2. The reference's own order is used instead.
  order_block <- paste0(
    "est <- est |>\n",
    "  mutate(\n",
    "    p = 100 * p, p_low = 100 * p_low, p_upp = 100 * p_upp,\n",
    "    resp = factor(\n",
    "      resp,\n",
    "      levels = ", r_vec(level_values, 17), ",\n",
    "      labels = ", r_vec(level_labels, 17), "\n",
    "    )",
    if (!is.null(grp)) {
      paste0(",\n    ", grp, " = factor(\n      ", grp, ",\n      levels = ",
             r_vec(split$levels, 17), "\n    )")
    } else "",
    "\n  )\n")

  fill <- if (is.null(grp)) "" else paste0(", fill = ", grp)
  dodge <- if (is.null(grp)) "" else
    "\n    position = position_dodge2(reverse = TRUE),"
  plot <- paste0(
    "ggplot(est, aes(x = p, y = fct_rev(resp)", fill, ")) +\n",
    "  geom_col(", if (is.null(grp)) "" else
      "position = position_dodge2(reverse = TRUE), ", "width = 0.8) +\n",
    "  geom_errorbar(\n",
    "    aes(xmin = p_low, xmax = p_upp),", dodge, "\n",
    "    width = 0.2, linewidth = 0.3\n",
    "  ) +\n",
    "  labs(\n",
    "    title = str_wrap(", r_title(question), ", 70),\n",
    "    x = \"Share of respondents (%)\",\n",
    "    y = NULL",
    if (is.null(grp)) "" else paste0(",\n    fill = ", r_quote(split$label)),
    "\n  ) +\n",
    "  theme_minimal()\n")

  paste0(
    paste(strwrap(question, 76, prefix = "# "), collapse = "\n"), "\n",
    "#\n",
    "# S3OK Public Survey, University of Oklahoma Institute for Public\n",
    "# Policy Research and Analysis. Rebuilds this chart from the public\n",
    "# wave files and nothing else.\n",
    paste(strwrap(
      paste0(if (length(wave_numbers) == 1) "Wave " else "Waves ",
             paste(wave_numbers, collapse = ", "), "."),
      76, prefix = "# "), collapse = "\n"), "\n",
    if (is.null(grp)) "" else
      paste0("# Split by ", str_to_lower(split$label), ".\n"),
    if (is.null(arm_column)) "" else
      paste0("# Version shown to this part of the sample: ", arm_label,
             " (`", arm_column, "`).\n"),
    "\n",
    "library(tidyverse)\n",
    "library(srvyr)\n\n",
    if (is.null(arm_column)) "" else paste0(
      "# This question was split-sampled - respondents did not all read the\n",
      "# same thing - so this version is estimated on its own. Pooling the\n",
      "# versions would average across the treatment.\n\n"),
    "# Read as character: a column that is empty for its first thousand rows\n",
    "# is otherwise guessed logical, which turns every real value after it\n",
    "# into NA.\n",
    paste0(obj, " <- read_csv(\n  ", r_quote(wave_files),
           ",\n  col_types = cols(.default = col_character())\n)",
           collapse = "\n"), "\n\n",
    "d <- bind_rows(\n", paste(stack, collapse = ",\n"), "\n) |>\n",
    "  filter(", paste(drops, collapse = ", "), ")", small_groups, "\n\n",
    est, "\n", order_block, "\n", plot)
}

# Verification -----------------------------------------------------------------
# Does the generated script rebuild the chart? Checked, not asserted. A script
# is run against the same wave files a reader would download and its estimates
# compared with the rows being written to the question file. Publishing code
# that does not reproduce the chart beside it would be worse than publishing
# none.
#
# read_csv is shimmed to a cache in the evaluation environment, so a run does
# not read the same eight files hundreds of times. Same arguments, same result.
r_code_cache <- new.env(parent = emptyenv())

cached_read_csv <- function(file, ...) {
  key <- paste0(survey_files, file)
  if (is.null(r_code_cache[[key]])) {
    r_code_cache[[key]] <- readr::read_csv(key, ...)
  }
  r_code_cache[[key]]
}

# `expect` is the rows being written to the question file: group, resp (the
# response code), p. `options` maps value to label.
verify_r_code <- function(script, expect, options, label) {
  e <- new.env(parent = globalenv())
  assign("read_csv", cached_read_csv, envir = e)
  ok <- try(suppressWarnings(suppressMessages(
    eval(parse(text = script), envir = e))), silent = TRUE)

  if (inherits(ok, "try-error")) {
    cat(script)
    stop("The generated R for ", label, " does not run: ",
         conditionMessage(attr(ok, "condition")))
  }

  # The script labels its responses, so the published codes are labelled to
  # match rather than the other way round. Comparing on the codes would not
  # notice a levels/labels pairing that had drifted.
  got <- get("est", envir = e) |> as_tibble()
  gcol <- setdiff(names(got), c("resp", "p", "p_low", "p_upp", "p_se"))
  got <- got |>
    transmute(
      group = if (length(gcol) == 1) as.character(.data[[gcol]]) else "All",
      resp = as.character(resp),
      gen = round(p, 2),
      gen_low = round(p_low, 2)
    )
  want <- expect |>
    left_join(options, by = c("resp" = "value")) |>
    transmute(group = as.character(group), resp = label, pub = round(p, 2),
              pub_low = p_low)

  cmp <- full_join(want, got, by = c("group", "resp"))
  # An interval is undefined on a cell at 0 or 100 percent, in both.
  low_off <- !is.na(cmp$pub_low) & !is.na(cmp$gen_low) &
    abs(cmp$pub_low - cmp$gen_low) > 0.011
  off <- is.na(cmp$pub) | is.na(cmp$gen) | abs(cmp$pub - cmp$gen) > 0.011 |
    low_off

  if (any(off)) {
    print(cmp[off, ])
    stop("The generated R for ", label, " does not reproduce its chart.")
  }
}

# Change Over Time -------------------------------------------------------------
# The script behind the view of change over time: the same three rules as
# above, and the same steps 02 takes. Stack the waves, keep the respondents
# who answered in every one (the balanced sample), give each the group they
# were in at the first of those waves, and estimate each wave: the average
# answer (`mean`, as a position among the options), the percentage answering
# yes (`share`), or the percentage giving each answer (`options`).
r_trend_script <- function(question, variable, wave_numbers, wave_files, split,
                           kind, level_values, level_labels,
                           missing_codes = character(0), min_group_n = 20) {
  obj <- paste0("wave_", wave_numbers)
  grp <- if (is.null(split)) NULL else split$id

  resp_expr <- if (length(missing_codes) == 0) r_name(variable) else
    paste0("if_else(", r_name(variable), " %in% ", r_vec(missing_codes, 0),
           ", NA_character_, ", r_name(variable), ")")

  stack <- map2_chr(obj, wave_numbers, function(o, wave) {
    lines <- c("      p_id", paste0("      wave = ", wave))
    if (!is.null(grp)) {
      lines <- c(lines, paste0("      ", grp, " = ",
                               paste(split$expr, collapse = "\n      ")))
    }
    lines <- c(lines, paste0("      resp = ", resp_expr))
    paste0("  ", o, " |>\n    transmute(\n", paste(lines, collapse = ",\n"),
           "\n    )")
  })

  grouping <- if (is.null(grp)) "" else paste0(
    " |>\n",
    "  # A person's group can change between waves, so each keeps the group\n",
    "  # they were in at the first of these waves.\n",
    "  mutate(", grp, " = ", grp, "[which.min(wave)], .by = p_id) |>\n",
    "  filter(!is.na(", grp, ")) |>\n",
    "  # A group with fewer than ", min_group_n, " respondents is not drawn.\n",
    "  filter(n_distinct(p_id) >= ", min_group_n, ", .by = ", grp, ")")

  factor_block <- paste0(
    "d <- d |>\n",
    "  mutate(\n",
    "    resp = factor(\n",
    "      resp,\n",
    "      levels = ", r_vec(level_values, 17), ",\n",
    "      labels = ", r_vec(level_labels, 17), "\n",
    "    )",
    if (!is.null(grp)) {
      paste0(",\n    ", grp, " = factor(\n      ", grp, ",\n      levels = ",
             r_vec(split$levels, 17), "\n    )")
    } else "",
    "\n  )\n")

  by <- paste(c(grp, "wave"), collapse = ", ")
  est <- paste0(
    "# Each wave on its own. The design clusters on the panelist for the\n",
    "# same reason the bar chart's does; within one wave each person\n",
    "# answers once.\n",
    "est <- d |>\n",
    "  as_survey_design(ids = p_id) |>\n",
    if (kind == "options") paste0(
      "  group_by(wave, resp) |>\n",
      "  summarise(\n",
      "    value = survey_prop(proportion = TRUE, vartype = \"ci\"),\n",
      "    .groups = \"drop\"\n",
      "  ) |>\n",
      "  mutate(across(c(value, value_low, value_upp), ~ 100 * .x))\n"
    ) else if (kind == "share") paste0(
      "  group_by(", by, ") |>\n",
      "  summarise(\n",
      "    value = survey_mean(resp == ",
      r_quote(level_labels[level_values == "1"]), ", vartype = \"ci\"),\n",
      "    .groups = \"drop\"\n",
      "  ) |>\n",
      "  mutate(across(c(value, value_low, value_upp), ~ 100 * .x))\n"
    ) else paste0(
      "  group_by(", by, ") |>\n",
      "  summarise(\n",
      "    # The average answer as a position among the options, 1 for the\n",
      "    # first.\n",
      "    value = survey_mean(as.integer(resp), vartype = \"ci\"),\n",
      "    .groups = \"drop\"\n",
      "  )\n"
    ))

  color <- if (kind == "options") ", color = resp" else
    if (is.null(grp)) "" else paste0(", color = ", grp)
  plot <- paste0(
    "ggplot(est, aes(x = wave, y = value", color, ")) +\n",
    "  geom_line() +\n",
    "  geom_point() +\n",
    "  geom_errorbar(aes(ymin = value_low, ymax = value_upp), width = 0.2) +\n",
    "  scale_x_continuous(breaks = ", r_num_vec(wave_numbers), ") +\n",
    if (kind == "mean") paste0(
      "  scale_y_continuous(\n",
      "    breaks = seq_along(levels(d$resp)),\n",
      "    labels = levels(d$resp),\n",
      "    limits = c(1, nlevels(d$resp))\n",
      "  ) +\n"
    ) else "  scale_y_continuous(limits = c(0, 100)) +\n",
    "  labs(\n",
    "    title = str_wrap(", r_title(question), ", 70),\n",
    "    x = \"Survey wave\",\n",
    "    y = ", r_quote(c(mean = "Average answer", share = "Answering yes (%)",
                         options = "Share of respondents (%)")[[kind]]),
    if (kind == "options") ",\n    color = \"Answer\"" else
      if (is.null(grp)) "" else paste0(",\n    color = ", r_quote(split$label)),
    "\n  ) +\n",
    "  theme_minimal()\n")

  paste0(
    paste(strwrap(question, 76, prefix = "# "), collapse = "\n"), "\n",
    "#\n",
    "# S3OK Public Survey, University of Oklahoma Institute for Public\n",
    "# Policy Research and Analysis. Rebuilds this chart from the public\n",
    "# wave files and nothing else: change over ",
    paste(strwrap(
      paste0("waves ", paste(wave_numbers, collapse = ", "), "."),
      76, prefix = "# "), collapse = "\n"), "\n",
    if (is.null(grp)) "" else
      paste0("# One line per ", str_to_lower(split$label), " group.\n"),
    "\n",
    "library(tidyverse)\n",
    "library(srvyr)\n\n",
    "# Read as character: a column that is empty for its first thousand rows\n",
    "# is otherwise guessed logical, which turns every real value after it\n",
    "# into NA.\n",
    paste0(obj, " <- read_csv(\n  ", r_quote(wave_files),
           ",\n  col_types = cols(.default = col_character())\n)",
           collapse = "\n"), "\n\n",
    "d <- bind_rows(\n", paste(stack, collapse = ",\n"), "\n) |>\n",
    "  filter(!is.na(resp)) |>\n",
    "  # The balanced sample: only respondents who answered in every wave,\n",
    "  # so a change is a change in answers, not in who took part.\n",
    "  filter(n() == ", length(wave_numbers), ", .by = p_id)", grouping,
    "\n\n",
    factor_block, "\n", est, "\n", plot)
}

# c(1, 2, 3) on one line, for wave numbers.
r_num_vec <- function(x) paste0("c(", paste(x, collapse = ", "), ")")

# `expect` is what is being published for this split: group (or option
# label), wave, value, low. The script labels its options, so an `options`
# expectation carries labels too.
verify_r_trend <- function(script, expect, label) {
  e <- new.env(parent = globalenv())
  assign("read_csv", cached_read_csv, envir = e)
  ok <- try(suppressWarnings(suppressMessages(
    eval(parse(text = script), envir = e))), silent = TRUE)

  if (inherits(ok, "try-error")) {
    cat(script)
    stop("The generated R for ", label, " does not run: ",
         conditionMessage(attr(ok, "condition")))
  }

  got <- get("est", envir = e) |> as_tibble()
  scol <- setdiff(names(got), c("wave", "value", "value_low", "value_upp",
                                "value_se"))
  got <- got |>
    transmute(
      series = if (length(scol) == 1) as.character(.data[[scol]]) else "All",
      wave = as.integer(wave),
      gen = round(value, 2),
      gen_low = round(value_low, 2)
    )
  want <- expect |>
    transmute(series = as.character(series), wave = as.integer(wave),
              pub = round(value, 2), pub_low = round(low, 2))

  cmp <- full_join(want, got, by = c("series", "wave"))
  low_off <- !is.na(cmp$pub_low) & !is.na(cmp$gen_low) &
    abs(cmp$pub_low - cmp$gen_low) > 0.011
  off <- is.na(cmp$pub) | is.na(cmp$gen) | abs(cmp$pub - cmp$gen) > 0.011 |
    low_off

  if (any(off)) {
    print(cmp[off, ])
    stop("The generated R for ", label, " does not reproduce its chart.")
  }
}
