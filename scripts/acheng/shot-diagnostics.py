"""Local model-facing shot checks; never infer or rewrite narrative facts."""
import re

def diagnostics(production, segment=None):
    result = []
    selected = set(segment.get('shot_ids', [])) if segment else None
    for index, shot in enumerate(production.get('shots', [])):
        if selected is not None and shot.get('id') not in selected:
            continue
        strict = shot.get('prompt_contract_version') == 2
        def issue(code, field, message, warning=False):
            result.append({'code': code, 'path': f'director.source.shots.{index}.{field}', 'targetId': shot.get('id'), 'severity': 'warning' if warning or not strict else 'error', 'message': message})
        segments = [s for s in production.get('segments', []) if shot.get('id') in s.get('shot_ids', [])]
        bound = {r.get('entity_id') for s in segments for r in s.get('references', []) if shot.get('id') in r.get('shot_ids', s.get('shot_ids', []))}
        bound.update(e for s in segments for r in s.get('references', []) if shot.get('id') in r.get('shot_ids', s.get('shot_ids', [])) for e in r.get('entity_ids', []))
        visible = {c.get('id') for c in shot.get('characters', [])}
        for character in shot.get('characters', []):
            if character.get('id') not in bound:
                issue('SHOT_IDENTITY_REFERENCE_MISSING', 'characters', f"Visible character {character.get('id')} has no scoped identity reference")
            if character.get('visible_from', 0) != 0 or character.get('visible_until', shot['end_frame']-shot['start_frame']) != shot['end_frame']-shot['start_frame']:
                issue('SHOT_VISIBILITY_WINDOW_CONFLICT', 'characters', 'Entry coordinates require a character visible throughout this independent Shot; split delayed entrances into another Shot')
        if visible.intersection(shot.get('offscreen_character_ids', [])):
            issue('SHOT_OFFSCREEN_ENTRY_CONFLICT', 'characters', 'The same character is declared offscreen and given visible entry coordinates')
        framing = shot.get('camera', {}).get('framing')
        for cue in shot.get('performance', {}).get('tracks', {}).values():
            if framing in {'CU', 'ECU'} and re.search(r'\bmedium (?:view|framing|shot)\b', cue.get('visibility', ''), re.I):
                issue('SHOT_FRAMING_VISIBILITY_CONFLICT', 'performance.tracks', 'Close framing conflicts with a medium-framing visibility instruction')
        duration = shot.get('end_frame', 0)-shot.get('start_frame', 0)
        last_voice = max((line.get('end', 0) for line in shot.get('dialogues', [])), default=0)
        for event in shot.get('performance', {}).get('events', []):
            if event.get('after_dialogue') and (not isinstance(event.get('start'), int) or not isinstance(event.get('end'), int) or event['start'] < last_voice or event['end'] <= event['start'] or event['end'] > duration):
                issue('SHOT_ACTION_TIME_MISSING', 'performance.events', 'An action after dialogue requires a positive frame window after the final utterance and inside the Shot')
        prose = shot.get('visual', '') + ' ' + ' '.join(shot.get('identity_context', {}).values())
        if re.search(r'\buntil it disappears\b', prose, re.I):
            issue('SHOT_AMBIGUOUS_DISAPPEARANCE', 'visual', 'Name the object or body swelling that disappears explicitly', True)
        if re.search(r'\b(eventually|later devises|becomes .* after the transformation)\b', prose, re.I):
            issue('SHOT_FUTURE_CONTEXT', 'identity_context', 'Review future story information in model-facing local context', True)
    return result
