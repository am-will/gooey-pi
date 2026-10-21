#!/usr/bin/env python3
"""Check repository-owned agent instructions for forced model routing."""
import argparse
from pathlib import Path
import re
import tempfile

SURFACES = ('.agents/skills', '.cursor/skills', '.cursor/agents', '.cursor/rules', '.claude/skills', '.claude/agents')
INSTRUCTIONS = ('AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', '.github/copilot-instructions.md')
TEXT_SUFFIXES = {'.md', '.mdc', '.py', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.toml'}
NAMED_MODEL = re.compile(r'\b(?:gpt|claude|grok|gemini|deepseek|qwen|llama|mistral|sonnet|opus|haiku|glm)[-_.:]\w[\w.:-]*', re.I)
BARE_MODEL_CLAUSE = re.compile(
    r'(?=.*\b(?:agent|subagent|reviewer|worker|runner|judge|model)\b)'
    r'(?=.*\b(?:spawn|use|using|run|pick|choose|assign|select|fine)\b)'
    r'.*\b(?:sonnet|opus|haiku)\b', re.I)
MODEL_FIELD = re.compile(r'(?:^|[{,\s])(?:[-*]\s*)?[`\"\']?(?:model|model_id|model_name)[`\"\']?\s*[:=]\s*[`\"\']?([\w.-]+)', re.I)
FAMILY_REQUIREMENT = re.compile(r'\b(?:different|another|distinct|same) model family\b|\b(?:cross|multi|diverse)-model\b', re.I)
INHERITED_VALUES = {'inherit-parent', 'auto', 'inherit', 'parent'}


def instruction_files(root):
    paths = {root / name for name in INSTRUCTIONS if (root / name).is_file()}
    for surface in SURFACES:
        directory = root / surface
        if directory.exists():
            paths.update(path for path in directory.rglob('*') if path.is_file() and path.suffix in TEXT_SUFFIXES)
    return sorted(paths)


def audit(root):
    findings = []
    paths = instruction_files(root)
    for path in paths:
        for number, line in enumerate(path.read_text().splitlines(), 1):
            field = MODEL_FIELD.search(line)
            reason = ('named model in agent instructions' if NAMED_MODEL.search(line) or BARE_MODEL_CLAUSE.search(line)
                      else 'explicit model field' if field and field.group(1).lower() not in INHERITED_VALUES
                      else 'model-family review requirement' if FAMILY_REQUIREMENT.search(line) else None)
            if reason:
                findings.append(f'{path.relative_to(root)}:{number}: {reason}: {line.strip()}')
    return paths, findings


def self_test():
    with tempfile.TemporaryDirectory(prefix='model-routing-audit-') as temporary:
        root = Path(temporary)
        skill = root / '.agents/skills/example/SKILL.md'
        skill.parent.mkdir(parents=True)
        skill.write_text('Omit `model` to inherit the current session.\nUse a typed data model.\n')
        assert not audit(root)[1]
        skill.write_text('model: legacy-special\nRequire a different model family.\n')
        assert len(audit(root)[1]) == 2
        skill.write_text('Spawn one subagent using the `sonnet` model.\nAn opus for solo piano.\n')
        assert len(audit(root)[1]) == 1
        skill.write_text('Spawn one general-purpose subagent (sonnet is fine).\nUse Sonnet for the reviewer.\nAn opus for solo piano.\n')
        assert len(audit(root)[1]) == 2
        skill.write_text('spawn_agent({"model": "legacy-special"})\n')
        assert len(audit(root)[1]) == 1
        skill.write_text('model: legacy-special\nRequire a different model family.\n')
        agent = root / '.cursor/agents/reviewer.md'
        agent.parent.mkdir(parents=True)
        agent.write_text('model: auto\n')
        assert len(audit(root)[1]) == 2
        skill.unlink()
        assert not audit(root)[1]
    print('Model-routing audit self-test passed.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--self-test', action='store_true')
    arguments = parser.parse_args()
    if arguments.self_test:
        self_test()
    paths, findings = audit(arguments.root.resolve())
    if findings:
        print('\n'.join(findings))
        raise SystemExit(1)
    print(f'No model-routing patterns found in {len(paths)} repository instruction files.')
