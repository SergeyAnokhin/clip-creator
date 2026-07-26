"""Seeds app_data/projects/ with the 3 demo poems from the design mock, so the
Home hub isn't empty on a fresh checkout. Only runs when no projects exist yet."""

from uuid import uuid4

from . import storage
from .slug import make_slug


def _block(type_, importance, content):
    return {'id': f'blk_{uuid4().hex[:8]}', 'type': type_, 'importance': importance, 'content': content}


def _empty_scenes(count=5):
    return [{'static_prompt': '', 'motion_prompt': '', 'images': []} for _ in range(count)]


def _seed_projects() -> list[dict]:
    now = '2026-07-26T22:00:00Z'
    return [
        {
            'author': 'Александр Пушкин', 'title': 'Зимнее утро', 'created_at': now, 'updated_at': now,
            'tags': ['Intro', 'Verse', 'Chorus'], 'auto_repeat_chorus': False,
            'blocks': [
                _block('intro', 3, 'Мороз и солнце; день чудесный!\nЕщё ты дремлешь, друг прелестный —'),
                _block('verse', 4, 'Пора, красавица, проснись:\nОткрой сомкнуты негой взоры\nНавстречу северной Авроры,\nЗвездою севера явись!'),
                _block('chorus', 5, 'Под голубыми небесами\nВеликолепными коврами,\nБлестя на солнце, снег лежит;\nПрозрачный лес один чернеет.'),
                _block('verse', 3, 'И ель сквозь иней зеленеет,\nИ речка подо льдом блестит.'),
                _block('bridge', 4, 'Вся комната янтарным блеском\nОзарена. Весёлым треском\nТрещит затопленная печь.'),
                _block('outro', 3, 'Приятно думать у лежанки.\nНо знаешь: не велеть ли в санки\nКобылку бурую запречь?'),
            ],
            'skill_prompt': 'Transform the following structured lyrics into a Suno-ready format using strict bracket tags [Verse], [Chorus], [Bridge], [Fade Out]. Optimize rhythm for singing, keep original imagery.',
            'style': 'Melodic Folk-Pop, Orchestral Strings, Warm Male Vocal, 92 BPM, Nostalgic Winter Atmosphere',
            'lyrics': '[Intro]\nМороз и солнце; день чудесный!\nЕщё ты дремлешь, друг прелестный —\n\n[Verse 1]\nПора, красавица, проснись...\n\n[Chorus]\nПод голубыми небесами...\n\n[Bridge]\nВся комната янтарным блеском...\n\n[Outro]\nПриятно думать у лежанки...',
            'track_url': '',
            'scenes': [
                {'static_prompt': 'Cinematic wide shot of a frozen Russian countryside at sunrise, golden light on snow, warm amber sky, highly detailed, 8k', 'motion_prompt': 'Slow camera pan across the frost, shimmering snow particles drifting in the wind', 'images': [{'label': 'Вариант 1', 'rating': 5, 'main': True}, {'label': 'Вариант 2', 'rating': 3, 'main': False}]},
                {'static_prompt': 'Close-up of a frosted window with morning light breaking through, warm interior glow contrasted with icy blue outside', 'motion_prompt': 'Gentle push-in through the window, light rays slowly intensifying', 'images': [{'label': 'Вариант 1', 'rating': 4, 'main': True}]},
                {'static_prompt': 'A young woman waking by a window, soft golden hour light, cozy wooden interior, painterly realism', 'motion_prompt': 'Slow motion of curtain moving in the breeze, hair gently drifting', 'images': []},
                {'static_prompt': 'Snow-covered pine forest under pale blue winter sky, frozen river reflecting light', 'motion_prompt': 'Camera glides low over the frozen river, snow sparkling', 'images': []},
                {'static_prompt': 'Interior of a wooden cabin, crackling fireplace casting amber light across the room, rustic textures', 'motion_prompt': 'Flickering firelight animation, gentle camera drift toward the hearth', 'images': []},
            ],
        },
        {
            'author': 'Марина Цветаева', 'title': 'Мне нравится, что вы больны не мной', 'created_at': '2026-07-24T18:10:00Z', 'updated_at': '2026-07-24T18:10:00Z',
            'tags': ['Verse', 'Chorus'], 'auto_repeat_chorus': False,
            'blocks': [
                _block('intro', 3, 'Мне нравится, что вы больны не мной,\nМне нравится, что я больна не вами,'),
                _block('verse', 4, 'Что никогда тяжёлый шар земной\nНе уплывёт под нашими ногами.'),
                _block('chorus', 5, 'Мне нравится, что можно быть смешной —\nРаспущенной — и не играть словами,'),
                _block('outro', 3, 'И не краснеть удушливой волной,\nСлегка соприкоснувшись рукавами.'),
            ],
            'skill_prompt': 'Transform the following structured lyrics into a Suno-ready format using strict bracket tags. Emphasize intimate, conversational phrasing suited to a slow tempo.',
            'style': 'Indie Chamber-Pop, Soft Piano, Female Vocal, 78 BPM, Intimate & Wistful',
            'lyrics': '[Intro]\nМне нравится, что вы больны не мной...\n\n[Verse]\nЧто никогда тяжёлый шар земной...\n\n[Chorus]\nМне нравится, что можно быть смешной...',
            'track_url': '',
            'scenes': [
                {'static_prompt': 'Two silhouettes standing apart in a softly lit room, muted warm tones, contemplative mood', 'motion_prompt': 'Very slow drift of dust particles in a light beam between them', 'images': [{'label': 'Вариант 1', 'rating': 4, 'main': True}]},
                {'static_prompt': '', 'motion_prompt': '', 'images': []},
                {'static_prompt': '', 'motion_prompt': '', 'images': []},
                {'static_prompt': '', 'motion_prompt': '', 'images': []},
                {'static_prompt': '', 'motion_prompt': '', 'images': []},
            ],
        },
        {
            'author': 'Сергей Есенин', 'title': 'Отговорила роща золотая', 'created_at': '2026-07-20T09:40:00Z', 'updated_at': '2026-07-20T09:40:00Z',
            'tags': ['Intro'], 'auto_repeat_chorus': False,
            'blocks': [
                _block('intro', 2, 'Отговорила роща золотая\nБерёзовым, весёлым языком,'),
                _block('verse', 3, 'И журавли, печально пролетая,\nУж не жалеют больше ни о ком.'),
            ],
            'skill_prompt': 'Transform the following structured lyrics into a Suno-ready format using strict bracket tags [Verse], [Chorus], [Fade Out].',
            'style': '', 'lyrics': '', 'track_url': '',
            'scenes': _empty_scenes(),
        },
    ]


def seed_if_empty() -> None:
    if storage.list_projects():
        return
    for project in _seed_projects():
        slug = make_slug(project['author'], project['title'])
        storage.save_project(slug, {'id': slug, **project})
