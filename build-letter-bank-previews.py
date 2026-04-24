#!/usr/bin/env python3

from pathlib import Path

from PIL import Image


ROOT_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = ROOT_DIR / "letter-bank-previews"
ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"

PREVIEW_SPECS = (
    {
        "variant": "classic",
        "target_size": (320, 420),
        "quality": 82,
        "sources": (
            ("uppercase-transparent", "uppercase-{letter}.webp", ALPHABET),
            ("lowercase-transparent", "lowercase-{letter}.webp", ALPHABET.lower())
        )
    },
    {
        "variant": "line",
        "target_size": (360, 360),
        "quality": 84,
        "sources": (
            ("uppercase-cutout", "uppercase-{letter}.webp", ALPHABET),
            ("lowercase-cutout", "lowercase-{letter}.webp", ALPHABET.lower())
        )
    }
)


def build_preview(source_path: Path, output_path: Path, target_size: tuple[int, int], quality: int) -> None:
    with Image.open(source_path) as source_image:
        image = source_image.convert("RGBA")
        image.thumbnail(target_size, Image.Resampling.LANCZOS)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        image.save(
            output_path,
            "WEBP",
            quality=quality,
            method=6
        )


def source_filename(folder_name: str, letter: str) -> str:
    return f"alphabet-letter-{letter}-4k.png"


def main() -> None:
    for preview_spec in PREVIEW_SPECS:
        variant_dir = OUTPUT_DIR / preview_spec["variant"]
        for source_folder, output_template, letters in preview_spec["sources"]:
            for letter in letters:
                source_path = ROOT_DIR / source_folder / source_filename(source_folder, letter)
                if not source_path.exists():
                    raise FileNotFoundError(f"Missing source asset: {source_path}")
                output_path = variant_dir / output_template.format(letter=letter)
                build_preview(source_path, output_path, preview_spec["target_size"], preview_spec["quality"])


if __name__ == "__main__":
    main()
