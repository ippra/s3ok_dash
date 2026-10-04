# S3OK dashboard

The S³OK Public Survey dashboard: a static site built from the public wave
files, in the look and structure of WxDash (`ippra/wxdash`), whose front end
it shares.

## Workflow

| step | what it is | output |
|---|---|---|
| `00_paths.R` | every path and the table of waves; sourced by each script | |
| `01_variable_reference/` | hand-maintained tables: question wording and topics, split-sample declarations, counties and regions | |
| `02_create_dashboard_data.R` | computes every statistic the site shows | `outputs/02_dashboard_data/` |
| `03_build_dashboard.R` | writes the page prose and assembles the site; computes no statistics | `outputs/03_site/` |

```
Rscript 00_run_pipeline.R      # steps 02 and 03, in order (maintainer only)
Rscript 03_build_dashboard.R   # step 03 alone: what a deploy needs
python3 preview.py             # then open http://127.0.0.1:8902/
```

Step 02 takes ten to twenty-five minutes and needs the location file that is
kept out of the repository (see Sources); step 03 takes seconds and needs
nothing beyond a clone. After a change to wording or to the front end, run
step 03 alone.

Serve over HTTP to preview: the site fetches its data, which `file://` blocks.
`outputs/03_site/` is the deployable site: plain files, every library
vendored, no third-party requests.

R packages: `tidyverse`, `jsonlite` and `here` for step 03; `srvyr`, `sf` and
`rmapshaper` as well for step 02.

## Deploying

Two deployments of one build.

**Beta: GitHub Pages, automatic.** `.github/workflows/deploy-beta.yml` runs
step 03 on every push to `main` that touches the site, the builder, the
reference tables or the computed data, and publishes the result to
https://ippra.github.io/s3ok_dash/. It sets `S3OK_CHANNEL=beta`, which puts a
Beta label beside the masthead title, adds a `noindex` tag and writes a
`robots.txt` that disallows everything, so the beta is never found in place
of production. The repository's Pages source must be set to GitHub Actions
(Settings, Pages).

The Action runs step 03 only. `outputs/02_dashboard_data/` is committed for
exactly this: step 02 takes twenty-five minutes and needs the location file
the repository does not carry, so it is run locally and reaches the beta when
its output is committed and pushed.

**Production: ippra.net, by hand.** Everything the build needs is in the
repository, so this works from a fresh clone on any machine with R; no
survey files, no `~/.Renviron`, and no step 02. From the repository root:

```
Rscript -e 'install.packages(c("tidyverse", "jsonlite", "here"))'  # once
Rscript 03_build_dashboard.R                                        # seconds
rsync -av --delete outputs/03_site/ <ippra.net host>:<docroot>/s3ok_dash/
```

Leave `S3OK_CHANNEL` unset: that is what makes it the production build, with
no Beta label and no `noindex`. The site is plain static files with relative
URLs, so it runs under any path and needs no server-side code. One server
setting: serve `index.html` with `Cache-Control: no-cache` (as for WxDash,
nginx sets it on the three entry URLs `/s3ok_dash`, `/s3ok_dash/` and
`/s3ok_dash/index.html`), so a new deploy is seen without a hard refresh;
everything else carries a `?v=<build>` stamp and can be cached as long as the
server likes.

To publish a newer version, pull `main`, run step 03 again and rsync again.
Only the dashboard's maintainer runs step 02; its output arrives in the
repository already computed.

## Layout

```
00_paths.R                    paths and waves
00_run_pipeline.R             runs 02 then 03
01_variable_reference/        inputs maintained by hand
02_create_dashboard_data.R    step 02
03_build_dashboard.R          step 03
data/                         the public wave files; the shared location
                              file also goes here but is not in the repository
helpers/                      sourced by the steps, never run on their own
  splits.R                    the 13 comparison groups, each as the R that derives it
  rcode.R                     generator for the R script behind each chart, and its check
  wording.R                   turns wording placeholders into words
site/                         the hand-edited front end
outputs/02_dashboard_data/    step 02's output, committed so a clone can build
outputs/03_site/              the built site; not committed
preview.py                    local preview server
```

Adding a wave: its file in `data/`, a row in `waves` (`00_paths.R`), its
questions in `variable_reference.csv`, and a level in the `WAVE` split
(`helpers/splits.R`).

## Pages

| page | what it shows |
|---|---|
| Home | what the project is, an animated map of the panel, four counted figures |
| Explore Survey Questions | search, one question at a time under 14 splits, question browser, R code for each chart; for a question asked in several waves, its change over time |
| Explore Key Topics | a whole battery on one chart: priorities, risk, experience, future risk, trust |
| Explore Regions | the same measures for the five regions, approximate respondent locations, a region overview sheet |
| Policy Narratives | Wave 1's open-ended answers, searchable |
| About | the survey, how to read results, publications, support |

## Decisions worth knowing

- **Public files only.** Step 02 stops if a wave file carries contact or
  location columns.
- **Unweighted.** The public files carry no weights, and every caption says
  so.
- **A panel.** Pooled charts count a person once per wave. Captions give
  responses and people, and intervals come from a design clustered on the
  panelist (`ids = p_id`).
- **Gender.** Respondents whose gender is neither female nor male are too few
  to chart as a group; they are left out of the Gender split only.
- **Top priority is per response:** the item ranked first in that wave.
- **Change over time** is estimated on a balanced sample: only respondents
  who answered the question in every wave that asked it, so a change is a
  change in answers rather than in who took part. What is drawn depends on
  the options (`scale_order` in the variable reference): the average answer
  for an ordered scale, the percentage answering yes for a yes/no question,
  and the percentage giving each answer for unordered options.
- **Small groups.** A group with fewer than 20 responses on a question is not
  charted, and the caption names it.
- **Split-sample questions** (`rand_temp`, `rand_loc_vis`) are estimated one
  version at a time, declared in `question_arms.csv` and `arms.csv`.
- **Field dates, not wave names.** The files name Wave 1 "Summer 2021", and
  it ran in February and March. The site shows dates read from the data.
- **Respondent locations** come from the shared location file, already
  displaced by up to 0.01 degrees, one dot per panelist, with no attributes.
- **The generated R is run.** For every question, step 02 runs two of its
  generated scripts (Everyone and one rotating split) against the wave files
  and stops if either does not reproduce its chart.

## Sources

| input | source |
|---|---|
| `data/Public_Wave_*_Survey_Data.csv` | https://dataverse.harvard.edu/dataverse/msisnet |
| `data/S3OK_MSISNet_Wave_1_8_Shared_Location_Data.csv` | exported by the project from the unreleased files, with coordinates displaced for sharing. **Not in the repository** (it is keyed by `p_id`); step 02 needs it and stops without it, so ask the project for a copy |
| `01_variable_reference/variable_reference.csv` | the project's question sheet, checked against the eight survey instruments (stems, wording, response labels), with topics assigned; `notes` records routing and where the sheet departs from an instrument |
| `01_variable_reference/ok_counties_2023.geojson` | Census cartographic boundary file, 2023, via `tigris::counties(state = "OK", cb = TRUE, year = 2023)` |
| `01_variable_reference/ok_counties_by_regions.csv` | the project's county-to-region table |
| `site/assets/vendor/` | Leaflet, Chart.js with its datalabels plugin, and jsPDF, as vendored in WxDash |
| `site/assets/img/` | the NSF and Oklahoma EPSCoR logos |
