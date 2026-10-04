# Human reviewer quality-control v2

Frozen protocol id: `main_v2`

Frozen implementation hash: `54829103ab729d6c820ced5413c7732c1178488ef109f8ceeb562fa6c20921bd`

The platform treats prior untagged / calibrated-task-v2 observations as `legacy_v1` evidence for sensitivity analysis only. The main reviewer model uses only completed `main_v2` sessions passing preregistered quality checks.

* 10 practice trials, then 30 main trials per participant.
* Main design: 40% assigned AI errors, three confidence levels balanced at 10 trials each.
* Three preregistered attention checks are stored but excluded from reviewer-model estimation.
* Trial exclusion: response time <800 ms or >60 s.
* Participant exclusion: >30% fast trials, >=2 attention failures, or 10 identical consecutive responses.
* Raw observations are never deleted; exclusion is represented by quality flags.
* Primary planned confirmatory analysis remains mixed-effects logistic regression `accept ~ ai_correct * confidence + (1|participant)`. The online fit gate uses participant-cluster bootstrap and will not produce a reviewer model unless the lower 95% CI of correct-vs-wrong acceptance discrimination is above zero.
* Target gate: at least 32 valid completed participants, >=300 correct-AI analyzable trials, and >=200 wrong-AI analyzable trials.

The browser records response time and page-visibility changes. Actual participant compensation and IRB workflow remain organizational responsibilities and are not simulated by the platform.
