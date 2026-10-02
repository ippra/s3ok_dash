# Splits -----------------------------------------------------------------------
# The groups a chart can be compared by. Each is declared once, here, as the R
# that derives it from the public wave files. 02 evaluates that expression to
# compute the statistics, and helpers/rcode.R writes the same text into the
# script a reader downloads, so the published code and the code that made the
# numbers are one string rather than two that could drift.
#
# `levels` is the order groups are drawn in. `phrase` completes the caption
# sentence "the percentage of each ___ selecting each response".
#
# Gender is charted as two groups. 35 of 16,473 responses give another gender,
# which is too few to chart as a group of its own; those respondents are in
# every other split and in Everyone.
#
# Education and income keep the cuts the earlier Shiny dashboard used.
splits <- list(
  list(
    id = "GENDER", label = "Gender", phrase = "gender",
    sources = "gend",
    levels = c("Female", "Male"),
    expr = c(
      "case_when(",
      "  gend == \"0\" ~ \"Female\",",
      "  gend == \"1\" ~ \"Male\"",
      ")"
    )
  ),
  list(
    id = "ETHNICITY", label = "Ethnicity", phrase = "ethnicity",
    sources = "hispanic",
    levels = c("Non-Hispanic", "Hispanic"),
    expr = c(
      "case_when(",
      "  hispanic == \"0\" ~ \"Non-Hispanic\",",
      "  hispanic == \"1\" ~ \"Hispanic\"",
      ")"
    )
  ),
  list(
    id = "RACE", label = "Race", phrase = "race group",
    sources = "race",
    levels = c("White", "African American", "Native American", "Other race"),
    expr = c(
      "case_when(",
      "  race == \"1\"                      ~ \"White\",",
      "  race == \"2\"                      ~ \"African American\",",
      "  race == \"3\"                      ~ \"Native American\",",
      "  race %in% c(\"4\", \"5\", \"6\", \"7\") ~ \"Other race\"",
      ")"
    )
  ),
  list(
    id = "AGE", label = "Age", phrase = "age group",
    sources = "age",
    levels = c("18-34", "35-59", "60+"),
    expr = c(
      "case_when(",
      "  as.numeric(age) >= 18 & as.numeric(age) <= 34 ~ \"18-34\",",
      "  as.numeric(age) >= 35 & as.numeric(age) <= 59 ~ \"35-59\",",
      "  as.numeric(age) >= 60                         ~ \"60+\"",
      ")"
    )
  ),
  list(
    id = "EDUCATION", label = "Education", phrase = "education group",
    sources = "education",
    levels = c("< College", "College", "> College"),
    expr = c(
      "case_when(",
      "  education %in% c(\"1\", \"2\", \"3\") ~ \"< College\",",
      "  education %in% c(\"4\", \"5\", \"6\") ~ \"College\",",
      "  education %in% c(\"7\", \"8\")      ~ \"> College\"",
      ")"
    )
  ),
  list(
    id = "INCOME", label = "Income", phrase = "income group",
    sources = "inc",
    levels = c("< $50k", "$50-$100k", "$100-$150k", "> $150k"),
    expr = c(
      "case_when(",
      "  inc == \"1\" ~ \"< $50k\",",
      "  inc == \"2\" ~ \"$50-$100k\",",
      "  inc == \"3\" ~ \"$100-$150k\",",
      "  inc == \"4\" ~ \"> $150k\"",
      ")"
    )
  ),
  list(
    id = "AREA", label = "Urban, suburban, rural", phrase = "community type",
    sources = "home_lot",
    levels = c("Urban", "Suburban", "Rural"),
    expr = c(
      "case_when(",
      "  home_lot == \"1\" ~ \"Urban\",",
      "  home_lot == \"2\" ~ \"Suburban\",",
      "  home_lot == \"3\" ~ \"Rural\"",
      ")"
    )
  ),
  list(
    id = "PARTY", label = "Party", phrase = "party group",
    sources = "party",
    levels = c("Democrat", "Republican", "Independent or other"),
    expr = c(
      "case_when(",
      "  party == \"1\"            ~ \"Democrat\",",
      "  party == \"2\"            ~ \"Republican\",",
      "  party %in% c(\"3\", \"4\") ~ \"Independent or other\"",
      ")"
    )
  ),
  list(
    id = "IDEOLOGY", label = "Ideology", phrase = "ideology group",
    sources = "ideol",
    levels = c("Liberal", "Moderate", "Conservative"),
    expr = c(
      "case_when(",
      "  ideol %in% c(\"1\", \"2\", \"3\") ~ \"Liberal\",",
      "  ideol == \"4\"                ~ \"Moderate\",",
      "  ideol %in% c(\"5\", \"6\", \"7\") ~ \"Conservative\"",
      ")"
    )
  ),
  list(
    id = "REGION", label = "Region", phrase = "region",
    sources = "region",
    levels = c("North Central", "Oklahoma City", "South East", "South West",
               "Tulsa"),
    expr = "region"
  ),
  list(
    id = "OCWP_REGION", label = "Water planning region",
    phrase = "water planning region",
    sources = "ocwp_region",
    levels = c("Panhandle", "West Central", "Southwest", "Beaver-Cache",
               "Upper Arkansas", "Central", "Lower Washita",
               "Middle Arkansas", "Eufaula", "Blue-Boggy", "Grand",
               "Lower Arkansas", "Southeast"),
    expr = "ocwp_region"
  ),
  # The wave has no column of its own in a wave file, so 02 supplies it and a
  # generated script writes the wave's name beside each file it reads.
  list(
    id = "WAVE", label = "Survey wave", phrase = "wave's respondents",
    sources = character(0),
    levels = paste("Wave", 1:8),
    expr = NULL
  ),
  list(
    id = "STUDY_AREA", label = "Little River watershed",
    phrase = "study area",
    sources = "study_area",
    levels = c("Inside Little River Watershed",
               "Outside Little River Watershed"),
    expr = "study_area"
  )
)
names(splits) <- vapply(splits, function(x) x$id, "")

split_ids <- c("All", names(splits))
