import os
import re
import subprocess
import logging
from typing import List, Tuple

def escape_regex(text: str) -> str:
    """Escape special regex characters in text"""
    return re.escape(text)

def find_links_to_file(base_dir: str, node_id: str, name: str) -> List[str]:
    """Find all files containing links to the specified node using ripgrep"""
    logging.info('=== Finding Links ===')
    logging.info('Search parameters: %s', {'base_dir': base_dir, 'node_id': node_id, 'name': name})

    escaped_name = escape_regex(name)
    escaped_node_id = escape_regex(node_id)

    # Three patterns to search for:
    # 1. Standard link: [[nodeId name]]
    # 2. Just the ID: [[nodeId]]
    # 3. Link with alt text: [[nodeId name|alt text]]
    patterns = [
        f"\\[\\[{escaped_node_id} {escaped_name}\\]\\]",
        f"\\[\\[{escaped_node_id}\\]\\]",
        f"\\[\\[{escaped_node_id} {escaped_name}\\|[^\\]]*\\]\\]"  # Match any alt text
    ]

    matching_files = set()
    for pattern in patterns:
        try:
            # Run ripgrep with the pattern
            result = subprocess.run(
                ['rg', '-l', pattern, base_dir],
                capture_output=True,
                text=True
            )
            if result.stdout:
                matching_files.update(result.stdout.splitlines())
        except subprocess.CalledProcessError as e:
            logging.error("Error running ripgrep: %s", e)

    return list(matching_files)

def update_links_in_file(
    file_path: str,
    old_node_id: str,
    old_name: str,
    new_node_id: str,
    new_name: str
) -> bool:
    """Update all links in a file from old format to new format"""
    logging.info('=== Updating Links in File ===')
    logging.info('Parameters: %s', {
        'file_path': file_path,
        'old_node_id': old_node_id,
        'old_name': old_name,
        'new_node_id': new_node_id,
        'new_name': new_name
    })

    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()

        # Create regex patterns for all link formats
        old_patterns = [
            # Standard link: [[nodeId name]]
            re.escape(f"[[{old_node_id} {old_name}]]"),
            # ID-only link: [[nodeId]]
            re.escape(f"[[{old_node_id}]]"),
            # Link with alt text: [[nodeId name|alt text]]
            f"\\[\\[{re.escape(old_node_id)} {re.escape(old_name)}\\|([^\\]]*)\\]\\]"
        ]

        # Replace each pattern
        for pattern in old_patterns:
            if '\\|' in pattern:  # Alt text pattern
                content = re.sub(
                    pattern,
                    f"[[{new_node_id} {new_name}|\\1]]",  # Preserve alt text
                    content
                )
            else:  # Standard patterns
                new_text = f"[[{new_node_id}]]" if pattern.endswith('\\]\\]"') else f"[[{new_node_id} {new_name}]]"
                content = re.sub(pattern, new_text, content)

        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)

        return True
    except Exception as e:
        logging.error("Error updating links in %s: %s", file_path, e)
        return False

def should_update_links(file_extension: str) -> bool:
    """Check if file type should have its links updated"""
    logging.info('=== Link Update Check ===')
    logging.info('File extension: %s', file_extension)
    supported = file_extension.lower() in ['.md', '.txt']
    logging.info('Should update links: %s', supported)
    return supported

def rename_and_update_links(
    base_dir: str,
    old_path: str,
    new_path: str,
    old_node_id: str,
    old_name: str,
    new_node_id: str,
    new_name: str
) -> Tuple[bool, List[str]]:
    """
    Rename a file and update all links to it in other files
    Returns: (success, list of updated files)
    """
    try:
        # Check if we should update links for this file type
        _, file_extension = os.path.splitext(old_path)
        if not should_update_links(file_extension):
            # Just rename the file if links shouldn't be updated
            os.rename(old_path, new_path)
            return True, []

        # First find all files containing links to this file
        affected_files = find_links_to_file(base_dir, old_node_id, old_name)

        # Rename the actual file
        os.rename(old_path, new_path)

        # Update links in all affected files
        updated_files = []
        for file_path in affected_files:
            # Only update links in supported file types
            _, ext = os.path.splitext(file_path)
            if should_update_links(ext):
                if update_links_in_file(
                    file_path,
                    old_node_id,
                    old_name,
                    new_node_id,
                    new_name
                ):
                    updated_files.append(file_path)

        return True, updated_files
    except Exception as e:
        logging.error("Error during rename operation: %s", e)
        return False, []
