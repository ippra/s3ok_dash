# Question Wording -------------------------------------------------------------
# The reference writes what varied between respondents as a placeholder in the
# question: `[rand_temp: 15|95]`, `[rand_loc_vis: Oklahoma | your local area]`.
# The page puts those into words in engine.js (readableWording()); this is the
# same rule in R, for the text R writes where a reader sees it - the comment
# and plot title of each generated script. Both 02 and 03 source this file:
# the builder sends `placeholder_words` to the page, and the statistics use
# readable_wording() for the scripts, so the two cannot name a placeholder
# differently.

# Placeholders that are not a version menu's own variable, in words a reader
# can follow. Anything not listed reads "[varied between respondents]".
placeholder_words <- c(
  .default = "varied between respondents"
)

# A listed set reads "[15 or 95]" and a range "[5 to 100]".
placeholder_text <- function(name, spec) {
  if (!is.na(spec) && str_detect(spec, "^\\s*\\d+\\s*:\\s*\\d+\\s*$")) {
    ends <- str_trim(str_split_1(spec, ":"))
    return(paste0("[", ends[1], " to ", ends[2], "]"))
  }
  if (!is.na(spec) && str_trim(spec) != "") {
    separator <- if (str_detect(spec, "\\|")) "\\|" else ","
    items <- str_trim(str_split_1(spec, separator))
    items <- items[items != ""]
    if (length(items) > 1) {
      return(paste0(
        "[", paste(items[-length(items)], collapse = ", "),
        if (length(items) > 2) "," else "", " or ", items[length(items)], "]"
      ))
    }
    return(paste0("[", items, "]"))
  }
  word <- placeholder_words[name]
  paste0("[", if (is.na(word)) placeholder_words[[".default"]] else word, "]")
}

# The question as a reader reads it. `arm_variable` and `arm_slot` are the
# version menu's variable and the words the shown version puts in its slot;
# without them every placeholder is put into words.
readable_wording <- function(text, arm_variable = NULL, arm_slot = NULL) {
  pattern <- paste0(
    "\\[([a-z][a-z0-9_]*)(?::\\s*([^\\]]*))?\\]|\\b(rand_[a-z0-9_]+)\\b"
  )
  hits <- str_match_all(text, pattern)[[1]]
  if (nrow(hits) == 0) return(text)
  spans <- str_locate_all(text, pattern)[[1]]
  out <- ""
  last <- 1
  for (i in seq_len(nrow(hits))) {
    name <- if (!is.na(hits[i, 2])) hits[i, 2] else hits[i, 4]
    own_slot <- !is.null(arm_variable) && name == arm_variable &&
      !is.null(arm_slot)
    words <- if (own_slot) arm_slot else placeholder_text(name, hits[i, 3])
    out <- paste0(out, str_sub(text, last, spans[i, 1] - 1), words)
    last <- spans[i, 2] + 1
  }
  str_squish(paste0(out, str_sub(text, last)))
}
