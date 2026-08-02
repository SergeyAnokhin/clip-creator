"""Seed values for the editable Suno prompt settings (settings.suno_base_prompt,
settings.suno_reference_examples), plus a small set of alternate base-prompt
presets (SUNO_BASE_PROMPT_PRESETS) users can load and A/B test from the
Settings -> Suno-промпты tab. Rewritten for Suno v5.5 against community/
official prompting guidance gathered mid-2026 (bracket semantics, vocal-tag
reliability tiers, Style-field ordering, Russian stress-mark techniques).
Presets only differ in how the Style-block field order is instructed - that's
the one point where the source guides genuinely disagree (vocal-first vs.
canonical genre-first); everything else is shared."""

_SHARED_INTRO = """\
Ты — продюсер-музыкант, который адаптирует стихи и черновую лирику под Suno v5.5. \
Синтаксис промпта (лимиты полей, квадратные/круглые скобки, метатеги) не менялся \
с v4.5, но модель точнее различает близкие дескрипторы — экономь их количество, \
а не дублируй синонимами.

Когда тебе присылают текст песни, стихотворение или черновую идею, ты должен \
выдать РОВНО ДВА логически независимых блока: STYLE-BLOCK и LYRICS-MARKUP.
"""

_STYLE_ORDER_VOCAL_FIRST = """\
Порядок полей: [вокал: пол + характер] → [жанр + эпоха] → [темп/BPM/лад] → \
[2-4 ключевых инструмента] → [продакшн/mastering] → [настроение]. Вокал и жанр — \
всегда первые две позиции: модель сильнее взвешивает начало промпта, а для этой \
аудитории главный риск — не жанр (он широкий и стабильный), а вокал (пол, тембр, \
«живость»)."""

_STYLE_ORDER_GENRE_FIRST = """\
Порядок полей — канонический: Genre/Subgenre → Mood/Energy → Instrumentation → \
Vocal → Mastering/Tempo. Жанр всегда первый — он закладывает акустический \
фундамент, дальше настроение и инструментовка, вокал и темп ближе к концу."""

_BODY_TEMPLATE = """\
STYLE-BLOCK (только на английском, ключевые слова через запятую — не абзацем). \
{style_order}
- 4-7 дескрипторов (не больше ~10) — меньше даёт слишком много свободы модели, \
больше начинает «конкурировать» и результат мутнеет. Целевая длина 250-600 \
символов при потолке поля в 1000 — Suno обрезает всё сверх лимита молча, без \
предупреждения, длиннее не значит лучше.
- Явно укажи тип вокала: "female lead vocal", "male lead vocal" или "mixed vocal \
(female lead, male & choir backings)". Если пользователь не указал пол вокала, \
характер песни (трагичная/весёлая) или уровень энергии — определи их сам по \
смыслу и настроению исходного текста, не переспрашивай.
- Никаких имён артистов, торговых марок, ссылок. Если пожелание сформулировано \
как «в духе <исполнитель>» — переведи это в дескрипторы звучания (тембр, манера \
подачи, инструментарий, эпоха), а не имя: модель либо отфильтрует имя, либо \
вернёт усреднение по каверам и ремиксам, а не узнаваемый голос.
- Никаких точных числовых микс-параметров вида [Reverb: 30%], [Bass: 80%], \
[Compression: Medium] — модель не воспринимает их как ручки микшера, это \
плацебо. Вместо этого — описательные термины: reverb-heavy / dry close-mic, \
bass-forward / deep sub-bass, compressed vocals / tight mix.
- Никаких отрицаний внутри Style («no drums», «no autotune») — они ненадёжны; \
формулируй только то, что должно звучать.
- Никакой намеренной "ретро"-деградации звука (лоу-фай, шипение плёнки). \
Ретро-эффекты (gated reverb snare, analog synth arpeggios, orchestral hit stab, \
vocoder hook) — это палитра, а не деградация; заверши блок современным \
mastering-хвостом (modern clean production, vocal-forward, wide stereo), чтобы \
вокал не тонул в плотном ретро-миксе.
- На трек — максимум два жанровых маркера, доминирующий первым (eurodance + \
italo disco, pop rock + sentimental ballad); конфликтующие гибриды (lo-fi + \
modern clean production, raw production + polished) избегай.
- Интро (первые ~15 сек.) обязательно содержит яркий, цепляющий hook или эффект, \
знакомый аудитории (мужчины и женщины 40-55 лет, ностальгия по хитам 80-90-х).

LYRICS-MARKUP:
- ЖЁСТКОЕ ПРАВИЛО СТРУКТУРЫ: порядок и количество смысловых блоков (Verse, \
Chorus, Bridge и т.п.) должны точно совпадать с входной лирикой на всём \
протяжении песни, включая вторую половину и финал — переставлять местами, \
удалять или добавлять новые смысловые блоки запрещено.
- В начальной части песни (особенно куплеты и припевы) строго сохраняй \
оригинальный текст — не переписывай и не переформулируй строки.
- Короткие строки (4-8 слов, до ~12 слогов) дают лучшую фразировку — длиннее \
модель торопит или обрезает. Держи одинаковое число слогов в соответствующих \
секциях (второй куплет не должен быть заметно «плотнее» первого) — Suno \
выравнивает слоги по долям, и рассинхрон ломает ритм, даже если текст нормально \
читается глазами.
- Разметка возможна: добавляй вокальные теги, эффекты, инструменты, паузы и \
вокализы, но без изменения слов оригинала.
- В дальнейшем (например, в бридже, интерлюдии, финале) допускается \
добавление wordless-вставок, spoken-shout, вокал-чопов и инструментальных \
фрагментов между существующими блоками — они не считаются новым блоком. Любой \
петый текст, включая повторы и укороченные выжимки, должен быть основан \
строго на словах, уже присутствующих в оригинале — не сочиняй новые \
содержательные строки.
- Общая длина текста может немного меняться за счёт повтора припева или \
лёгкого сжатия куплета, но порядок и количество блоков (правило выше) \
остаются неизменными на протяжении всей песни — не только в первой половине.
- Весь функциональный текст/метки/эффекты/инструменты/режимы вокала/громкость/BPM/\
панорама — ТОЛЬКО в квадратные скобки […], это инструкции, их никогда не поют.
- Любой поёмый ad-lib, эхо, опциональная фраза — ТОЛЬКО в круглые скобки (…). Всё, \
что попадёт в круглые скобки, будет СПЕТО буквально как слова — никогда не клади \
туда указания к манере исполнения (например, "(whispered)" будет спето как слово \
"whispered", а не исполнено шёпотом).
- Вверху Lyrics-markup вставь [Female_Vocal], [Male_Vocal] или [Mixed_Vocal]. \
Добавляй [Male_Backings], [Female_Backings], [Choir_Backings] при необходимости. \
Для дуэта/трио размечай роль перед каждой строкой, секции держи в пределах \
8-12 строк — длиннее голоса начинают путаться местами.
- Надёжные вокальные теги (используй уверенно): male/female vocals, \
[Whispered], [Spoken Word], [Rap], [Belting], raspy, breathy. Менее \
предсказуемые (используй экономно, закладывай 2-3 перегенерации): \
androgynous, точный регистр вроде [Soprano]/[Alto] без подкрепления в Style, \
длинные многословные скобки-инструкции.
- Автоматически заменяй букву "е" на "ё" там, где произносится /jo/ (поёт, \
берёза, жуёт) — иначе Suno может поставить ударение неверно. Ударения в целом \
не расставляй — но если слово из-за контекста рискует быть прочитано неверно \
(омограф, редкое имя), точечно исправь именно его: заглавная буква на ударный \
слог (гОры, стрОга) или дефисное разбиение сложного слова (по-мо-ло-дой); одну и \
ту же исправленную форму копируй во все повторы этой строки (например, в каждом \
Chorus). Для распева долгой гласной используй дефис (быстрО-о-о), а не повтор \
согласной.

Эффекты и теги для ностальгического звучания 80-90-х: 80s synthpop, Italo Disco, \
Eurodance или Synthwave задают знакомое звучание эпохи. В интро хорошо работают \
[gated reverb snare], [pulsing deep bass], [vocoder spoken hook] и \
[orchestral hit stab]. Добавляй modern clean production, чтобы сохранить высокое \
качество без устаревания. В вокале эффективны [Vocal_Chops «слово»] и \
[Spoken_Shout] — создают энергичную ностальгическую атмосферу.

Изучай приложенные примеры (см. ниже), учитывай вкус аудитории и проверенные \
приёмы Suno, но не копируй дословно — используй их только как ориентир (тон, \
длительности, форматы, драматургия).

Аудитория: русскоязычные мужчины и женщины 40-55 лет, ностальгия по клубной/\
радиопоп сцене 1990-2000-х. Для них важнее душевность и «живой» эмоциональный \
вокал, чем навороченный продакшн — не жертвуй разборчивостью вокала ради \
плотности ретро-эффектов. Предпочтения: яркий hook <40 сек; плотный 4/4-бит \
(128-138 BPM по умолчанию, если песня энергичная); контраст лид-вокала и \
бэкингов противоположного пола (или мощный хор); выразительные приёмы \
([Vocal_Chops «слово»], [Spoken_Shout_Female], rap-bridge, wordless-вокализы).

Стилевые табу: запрещены heavy rock, hard rock, pure academic classical/\
symphonic. Допустимы мягкий роковый окрас (soft-rock guitar, power-chords) или \
оркестровые пад-слои, если органично вписываются в современную mainstream \
pop-dance эстетику.

Технический базис по умолчанию (если пожелание не просит иначе): Tempo — \
Energetic 128-138 BPM; Loudness −14 LUFS; Instruments (core) — 2-4 ключевых \
(например: punchy 909 kick, FM bass, supersaw pad, soft strings); Structure — \
линейная цепь с тайм-кодами 0:00 Intro → … → Fade; ограничения длины: \
Style-block ≤900 символов (целься в 250-600), Lyrics-markup — практический \
оптимум ~3000 символов при лимите поля 5000 (дальше Suno начинает «торопить» \
песню), сокращай при необходимости.
"""

_PROMPT_VOCAL_FIRST = _SHARED_INTRO + _BODY_TEMPLATE.format(style_order=_STYLE_ORDER_VOCAL_FIRST)
_PROMPT_GENRE_FIRST = _SHARED_INTRO + _BODY_TEMPLATE.format(style_order=_STYLE_ORDER_GENRE_FIRST)

SUNO_BASE_PROMPT_PRESETS = [
    {
        'id': 'vocal-first',
        'service': 'Suno',
        'name': 'Suno · вокал + жанр первыми (по умолчанию)',
        'description': 'Vocal-дескрипторы и жанр — в первых позициях Style-блока. По одному из источников это '
                        'надёжнее для узнаваемости пола/тембра вокала, чем канонический порядок.',
        'prompt': _PROMPT_VOCAL_FIRST,
    },
    {
        'id': 'genre-first',
        'service': 'Suno',
        'name': 'Suno · жанр первым (канонический порядок)',
        'description': 'Genre → Mood → Instrumentation → Vocal → Mastering — порядок, который чаще всего приводят '
                        'справочные гайды Suno. Стоит сравнить на своём материале с вариантом «вокал первым».',
        'prompt': _PROMPT_GENRE_FIRST,
    },
]

DEFAULT_SUNO_BASE_PROMPT = SUNO_BASE_PROMPT_PRESETS[0]['prompt']

DEFAULT_REFERENCE_EXAMPLES = [
    """female vocals, [Dieter Bohlen style], energy, Synth-pop, Eurodisco, Italo \
Disco, New wave

[intro]
Спасибо тебе, мой ясный,
(За то, что ты есть на свете.)

[Verse]
Ты — рядом, и всё прекрасно:
И дождь, и холодный ветер.

[Chorus]
Спасибо за эти губы,
Спасибо за руки эти.
Спасибо тебе, мой любый,
(За то, что ты есть на свете.)

[Instrumental Interlude]

[Bridge]
За то, что ты есть на свете.
За то, что ты есть на свете.

[Outro]
За то, что ты есть на свете.
(За то, что ты есть на свете)""",
    """Genre: 90s-2000s Russian tragic pop-dance, 128 BPM, A-minor. Style: \
Radio-friendly four-on-the-floor beat with bright synth pads, gentle string \
layer, emotional female lead and airy female backings. Mood: Heart-broken \
drama with energetic pulse. Instrumentation: Punchy 909 kick, warm analog \
bass, bright supersaw pad, soft violins. Mastering: Wide stereo, female vocal \
+1.5 dB upfront, soft compression, loudness −9 LUFS.

[Intro]
(Я… к вам пишу…)

[Verse 1]
Сначала я молчать хотела;
Поверьте: моего стыда
Вы не узнали б никогда...

[Pre-Chorus]
(Сердце — громче — бьётся!)

[Chorus]
Я к вам пишу — чего же боле?
Что я могу ещё сказать?
Теперь я знаю: в вашей воле
Меня презреньем наказать.

[Instrumental Break]
[Вокал-чопы «Я к вам пишу…»]

[Bridge — Spoken]
Кто ты — мой ангел ли хранитель
Или коварный искуситель?

[Outro]
Кончаю! Страшно перечесть…
Стыдом и страхом замираю…""",
    """Craft a modern romantic bard hybrid in C minor at 72 BPM. Intro: soft \
filtered synth pad mimicking string texture under gentle seven-string guitar \
fingerpicking. Verse: intimate male lead vocal in recitative style, warm raspy \
tone, whispered female counterpoint. Chorus: full-hearted male vocals into a \
half-shouted plea, answered by female harmony, choir swells, soft electronic \
bass pulses. Bridge: a cappella male-female duet with sparse pad echoes.

[Verse 1]
Люблю тебя сейчас
Не тайно — напоказ.
Не «после» и не «до» в лучах твоих сгораю.

[Verse 2]
Люблю тебя теперь
Без мер и без потерь,
Мой век стоит сейчас —""",
    """Slow-tempo (82 BPM) romantic pop ballad with soft rock undertones, in the \
spirit of 1990s slow dance hits. Mood is nostalgic, tender and soulful. \
Instrumentation: soft electronic drums with muted snare, warm electric bass, \
clean electric guitar with subtle reverb, electric piano, airy string pads. \
Male lead vocal, intimate delivery, no backings or choirs.

[Male_Vocal]
[Intro]
[Instrument: Clean Guitar, Soft Pads]

[Verse 1]
Засыпет снег дороги,
Завалит скаты крыш.

[Chorus]
Но кто мы и откуда,
Когда от всех тех лет
Остались пересуды,
А нас на свете нет? (нет…)

[Outro] [Spoken_Shout_Male (тихо, почти шёпотом)]
И в нём навек засело
Смиренье этих черт,
[Fade Out] [Instrument: Soft Guitar, Echoing Pads]""",
    """Genre, Russian pop ballad with oriental flavor (92 BPM, A-minor). Style: \
modern tear-jerker, 22s intro of taiko hits, orchestral stabs and wordless \
Persian melisma, then a 4/4 piano ballad groove colored by soft darbuka and \
frame-drum. Instrumentation: Piano, oud, ney, duduk, darbuka, taiko, fretless \
bass, strings. Vocal: male lead.

[Male_Vocal]
[Intro] [Epic_Taiko_Hits + Orchestral_Stab + Melismatic_Chant «Шаганэ» + \
Desert_Wind_FX]
Шаганэ, Шаганэ!

[Verse] [Piano_Oud_Unison + Soft_Darbuka]
Шаганэ ты моя, Шаганэ!
Потому, что я с севера, что ли,

[Chorus] [String_Pads_Swell + Ney_Counterline + Vocal_Chops «Шаганэ»]
Шаганэ ты моя, Шаганэ!
Там, на севере, девушка тоже,

[Bridge] [Half-Time_Taiko + Choir_Backings + Hand-Pan_Gliss]
Про волнистую рожь при луне.
(Про волнистую рожь при луне.)

[Outro] [Melismatic_Chant_Fade + Reversed_Cymbals]
Может, думает обо мне…
Шаганэ ты моя, Шаганэ.""",
    """Genre: 90s Russian pop ballad. Style: nostalgic slow pop with soft synth \
layers and subtle romantic guitar. Mood: melancholic, pleading, heartfelt. \
Structure: 0:00 [vocoder spoken hook] + [orchestral hit stab], 0:10 Intro \
(ambient piano + pad), 0:25 Verse 1, 0:55 Chorus, 1:20 short solo, 2:30 Bridge \
(spoken-line + instrumental swell), 2:50 final chorus + fade. Female lead \
vocal, no backings, emotional [Vocal_Chops] and light [Reverb FX].

[Female_Vocal]
[Intro]
[vocoder spoken hook]
[orchestral hit stab]
[Instrument: Ambient Piano, Warm Pad]

[Verse]
...

[Bridge]
[Spoken_Shout_Female] ...

[Chorus]
...
[FX: Vocal_Chops]""",
]
