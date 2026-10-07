# Appended to the candidate runtime only. Original source and old runtimes stay intact.
_canvas_original_prepare_asset_card = prepare_asset_card
_canvas_legacy_character_layout = copy.deepcopy(DEFAULT_CHARACTER_VIEW_LAYOUT)
DEFAULT_CHARACTER_VIEW_LAYOUT = {
    **DEFAULT_CHARACTER_VIEW_LAYOUT,
    "views": ["front_face_above_clavicle", "front_full_body", "side_full_body", "back_full_body"],
    "row_height_ratio": [1, 1],
}
_canvas_creature_views = ["front_head", "side_head", "coiled_full_body", "mid_body_scale_detail"]


def character_layout_profile(card, payload):
    layout = card.get("view_layout") or copy.deepcopy(DEFAULT_CHARACTER_VIEW_LAYOUT)
    planned = next((entry for entry in payload.get("asset_plan", []) if entry.get("id") == card.get("id")), {})
    historical = payload.get("prompt_detail_policy", {}).get("profile") == "legacy_fixture" or (
        planned.get("status") == "approved" and layout.get("views") == _canvas_legacy_character_layout["views"])
    if historical:
        return "historical"
    selection = layout.get("selection")
    need(selection in (None, "user_explicit"), "unsupported character layout selection")
    if selection == "user_explicit":
        need(prose(layout.get("selection_reason")), "explicit character layout selection_reason required")
        need(layout.get("order") == "grid_2x2" and layout.get("same_subject") is True and prose(layout.get("purpose")),
             "explicit character layout requires order, same_subject and purpose")
        if layout.get("type") == "four_view_character_turnaround" and layout.get("views") == _canvas_legacy_character_layout["views"]:
            need(layout.get("row_height_ratio") == [1, 2], "explicit headless character row heights must be 1:2")
            return "headless"
        if layout.get("type") == "four_view_creature_turnaround" and layout.get("views") == _canvas_creature_views:
            need(layout.get("row_height_ratio") == [1, 1], "explicit creature row heights must be equal")
            return "creature"
        need(False, "unsupported explicit character view layout")
    need(layout.get("type") == "four_view_character_turnaround" and layout.get("views") == DEFAULT_CHARACTER_VIEW_LAYOUT["views"],
         "legacy character views require explicit migration")
    need(layout.get("order", "grid_2x2") == "grid_2x2", "character layout must use grid_2x2")
    need(layout.get("row_height_ratio", [1, 1]) == [1, 1], "character row heights must be equal")
    return "default"


def check_character_view_layout(card, payload):
    profile = character_layout_profile(card, payload)
    text = card.get("prompt", "").lower()
    need(all(marker in text for marker in ("top left:", "top right:", "bottom left:", "bottom right:")),
         "character prompt missing fixed panel contract")
    if profile in ("headless", "historical"):
        need("top and bottom row heights must be in a 1:2 ratio" in text and "completely crop out head and face" in text,
             "character prompt missing headless row height contract")
    elif profile == "creature":
        need("four-view creature turnaround" in text and "coiled" in text and "scale" in text,
             "creature prompt missing declared anatomical views")
    else:
        need("four-view character turnaround" in text and "four equal-height panels" in text,
             "character prompt missing equal-height layout contract")


def prepare_asset_card(card, payload):
    global DEFAULT_CHARACTER_VIEW_LAYOUT
    nodes = {entry["id"]: entry for entry in payload.get("asset_plan", [])}
    node = nodes.get(card.get("id"), {})
    kind = card.get("asset_kind") or node.get("kind")
    if kind != "character":
        return _canvas_original_prepare_asset_card(card, payload)
    profile = character_layout_profile(card, payload)
    if profile in ("headless", "historical"):
        current = DEFAULT_CHARACTER_VIEW_LAYOUT
        try:
            DEFAULT_CHARACTER_VIEW_LAYOUT = _canvas_legacy_character_layout
            return _canvas_original_prepare_asset_card(card, payload)
        finally:
            DEFAULT_CHARACTER_VIEW_LAYOUT = current
    need(not card.get("asset_kind") or not node.get("kind") or card["asset_kind"] == node["kind"], "asset card/plan kind conflict")
    result = copy.deepcopy(card)
    registry = {entry.get("id"): entry for entry in payload.get("character_registry", [])}
    character = registry.get(node.get("entity_id"), {})
    result["asset_kind"] = "character"
    result["character_name"] = result.get("character_name") or character.get("name") or result.get("name") or result["id"]
    result["state_label"] = result.get("state_label") or "neutral_identity"
    layout = result.get("view_layout") or copy.deepcopy(DEFAULT_CHARACTER_VIEW_LAYOUT)
    need(not any(word in result.get("prompt", "").lower() for word in ("headless", "crop out head", "1:2 ratio", "无头")), "conflicting historical character layout")
    layout["order"], layout["row_height_ratio"] = "grid_2x2", [1, 1]
    result["view_layout"] = layout
    directive = (
        f"Create a clean four-view character turnaround board of {result['character_name']} in the approved {result['state_label']} state. "
        "Use four equal-height panels in a 2x2 grid with equal column widths. "
        "Top left: frontal face close-up above the clavicle. Top right: complete front full body including head and shoes. "
        "Bottom left: complete side full body including head and shoes. Bottom right: complete back full body including head and shoes. "
        "Keep identity, proportions, hairstyle and clothing consistent; neutral standing pose, hands empty, orthographic view without perspective distortion, neutral light-grey background. "
        "Inherit only the project's defined character traits and style, never another character's identity or pose. "
        "Strict clean render: no text, no watermark, no labels. No weapons, missing heads, cropped feet, costume changes or extra figures. "
    )
    if profile == "creature":
        directive = (
            f"Create a clean four-view creature turnaround board of {result['character_name']} in the approved {result['state_label']} state. "
            "Use four equal-height panels in a 2x2 grid with equal column widths. "
            "Top left: frontal head view. Top right: head side profile. "
            "Bottom left: complete coiled body. Bottom right: mid-body scale detail. "
            "Keep the same anatomy, scale pattern, proportions and colors across all panels; neutral light-grey background and consistent lighting. "
            "No humanoid costume board or invented limbs. No text, no watermark, no labels. "
        )
    if directive not in result.get("prompt", ""):
        result["prompt"] = directive + result.get("prompt", "")
    if result.get("seven_steps"):
        if directive not in result["seven_steps"][0].get("content", ""):
            result["seven_steps"][0]["content"] = directive + result["seven_steps"][0].get("content", "")
    return result
