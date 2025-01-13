# %%
import os
import logging
from typing import List
# from .file_graph import FileGraph

def is_valid_node_id(node_id: str) -> bool:
    """
    Validates node ID format:
    - Root: 2 digits (e.g., "07")
    - Level 1+: Previous + any non-numeric char + optional 2 digits with optional special character at end
      Examples: "07a", "07a01", "07#", "07#01", "07a01b02"
    """
    if len(node_id) < 2:
        return False

    # Root level must be exactly 2 digits
    if len(node_id) == 2:
        return node_id.isdigit()

    # Check the pattern: 2 digits followed by alternating non-digit and 2 digits
    pos = 0

    # First two characters must be digits
    if not node_id[pos:pos+2].isdigit():
        return False
    pos += 2

    # Rest of the ID must alternate between:
    # - one non-digit character
    # - optionally followed by two digits
    # - optionally, at the end, a special character
    while pos < len(node_id):
        print(pos)
        # Must have non-digit character
        if pos >= len(node_id) or node_id[pos].isdigit():
            return False
        pos += 1

        # Must follow letter with two digits if more than one character remains.
        if not node_id[pos - 1].isdigit():
            if pos <= len(node_id) - 2:
                if not node_id[pos].isdigit() and not node_id[pos + 1].isdigit():
                    return False

                # if not node_id[pos].isdigit():
                #     continue
                # if pos + 1 >= len(node_id) or not node_id[pos+1].isdigit():
                #     return False
                pos += 2
            elif pos == len(node_id) - 1:
                # if there's only one character remaining, after a nondigit, it must be a special character
                if node_id[pos] not in "!@#$%^&*_": return False

        # May have a special character at the very end (following both numeric and nonnumeric stuff)
        if pos == len(node_id)-1 and node_id[pos] in "!@#$%^&*_":
            pos += 1
            continue

    return True
is_valid_node_id("01a")
# %%
# %% Testing
# %%


def get_parent_id(node_id: str) -> str:
    """Returns the parent ID based on the node's level"""
    if len(node_id) <= 2:  # Root nodes have no parent
        return ""
    elif len(node_id) == 3:  # First level nodes (parent is first 2 digits)
        return node_id[:2]
    else:  # Second level and beyond
        # If last character is non-numeric, remove just that character
        if not node_id[-1].isdigit():
            return node_id[:-1]
        # Otherwise remove last two digits
        return node_id[:-2]

def get_next_available_child_id(parent_stable_id: str, graph: dict, parent_id: str = None) -> str:
    """
    Get the first available child ID for a given parent node in the graph.

    Args:
        parent_stable_id: The stable ID of the parent node in the graph
        graph: The directed file graph containing nodes and edges
        parent_id: Optional folgezettel ID of the parent node (e.g., '08r' or '08r03').
                  If not provided, will be retrieved from the graph.

    Returns:
        str: The next available child ID (e.g., '08r03a' if parent ends in number,
             or '08r03c' if '08r03a' and '08r03b' exist), or empty string if parent
             has no folgezettel ID

    Examples:
        - Parent '08r' -> children like '08r01', '08r02', etc.
        - Parent '08r03' -> children like '08r03a', '08r03b', etc.
        - Parent '08r03b' -> children like '08r03b01', '08r03b02', etc.
        - Parent with no folgezettel ID -> ''
    """
    # Check if parent exists and get its ID if not provided
    if parent_stable_id not in graph.all_nodes:
        raise ValueError(f"Parent node {parent_stable_id} not found in graph")

    if parent_id is None:
        parent_id = graph.folgezettel_ids[parent_stable_id]

    # parent_node = graph.['nodes'][parent_stable_id]
    # if parent_id is None:
    #     parent_id = parent_node.get('id', '')

    if not parent_id:
        return ''

    # Get all children of the parent using graph edges
    child_ids = set()
    for child_stable_id in graph.edges.get(parent_stable_id, set()):
        child_id = graph.folgezettel_ids[child_stable_id] #['nodes'][child_stable_id].get('id', '')
        if child_id.startswith(parent_id):
            child_ids.add(child_id)

    # Determine if we should add a number or letter based on parent_id
    if parent_id[-1].isdigit():
        # Parent ends in number, add letters
        used_letters = {child_id[len(parent_id)]
                       for child_id in child_ids
                       if len(child_id) > len(parent_id)}

        # Find first unused letter (a-z)
        for letter in 'abcdefghijklmnopqrstuvwxyz':
            if letter not in used_letters:
                return f"{parent_id}{letter}"

        raise ValueError(f"No available letter suffixes for parent {parent_id}")

    else:
        # Parent ends in letter (or is root), add two-digit numbers
        used_numbers = {child_id[len(parent_id):len(parent_id)+2]
                       for child_id in child_ids
                       if len(child_id) >= len(parent_id) + 2}

        # Find first unused two-digit number
        for i in range(1, 100):
            candidate = f"{i:02d}"
            if candidate not in used_numbers:
                return f"{parent_id}{candidate}"

        raise ValueError(f"No available number suffixes for parent {parent_id}")

def get_all_parent_ids(node_id: str) -> List[str]:
    """Returns all parent IDs for a given node ID, from immediate parent to root"""
    parents = []
    current_id = node_id

    while True:
        parent_id = get_parent_id(current_id)
        if not parent_id:  # Stop when we hit root level (empty parent)
            break
        parents.append(parent_id)
        current_id = parent_id

    return parents

def get_stable_file_id(filepath: str) -> str:
    """Get the stable ID for a file using nanosecond precision creation time"""
    stat = os.stat(filepath)
    # Use the earliest time we can find (creation time on Windows, earliest of ctime/mtime on Unix)
    creation_time = min(stat.st_ctime_ns, stat.st_mtime_ns)
    return str(creation_time)

def validate_node(node) -> None:
    """Validate node data consistency"""
    if node.is_directory and node.extension:
        logging.warning(f"Directory node has extension: {node.path}")
    if node.id and not is_valid_node_id(node.id):
        logging.warning(f"Invalid node ID: {node.id}")

def get_stable_id_from_folgezettel(graph: 'FileGraph', folgezettel_id: str) -> str:
    """
    Find the stable ID of a node given its folgezettel ID.

    Args:
        graph: FileGraph instance containing the nodes and their data
        folgezettel_id: The folgezettel ID to search for (e.g., '01a' or '02b03')

    Returns:
        str: The stable ID of the node, or None if not found

    Example:
        >>> graph = FileGraph()
        >>> # ... graph populated with nodes ...
        >>> get_stable_id_from_folgezettel(graph, "01a")
        "123456"
    """
    for stable_id, fid in graph.folgezettel_ids.items():
        if fid == folgezettel_id:
            return stable_id
    return None

def get_folgezettel_ids_from_graph(graph) -> List:
    """Given a FileGraph, returns all folgezettel ids"""
    # fids = []
    return graph.folgezettel_ids.values()
    # for n in graph["nodes"].values():
    #     fids.append(n["id"])
    # return fids

def get_next_available_child_id(parent_id: str, graph: dict) -> str:
    """
    Get the first available child ID for a given parent ID in the graph.

    Args:
        parent_id: The folgezettel ID of the parent node (e.g., '08r' or '08r03')
        graph: The directed file graph containing nodes and edges

    Returns:
        str: The next available child ID (e.g., '08r03a' if parent ends in number,
             or '08r03c' if '08r03a' and '08r03b' exist)

    Examples:
        - Parent '08r' -> children like '08r01', '08r02', etc.
        - Parent '08r03' -> children like '08r03a', '08r03b', etc.
        - Parent '08r03b' -> children like '08r03b01', '08r03b02', etc.
    """
    # Find the parent node's stable ID
    print("parent fid: ",parent_id)
    parent_stable_id = get_stable_id_from_folgezettel(graph, parent_id)
    # for stable_id, node_data in graph['nodes'].items():
    #     if node_data.get('id') == parent_id:
    #         parent_stable_id = stable_id
    #         break

    if parent_stable_id is None:
        raise ValueError(f"Parent node {parent_id} not found in graph")

    # Get all children of the parent using graph edges
    child_ids = set()
    for child_stable_id in graph.edges.get(parent_stable_id, set()):
        child_id = graph.folgezettel_ids[child_stable_id]
        if child_id.startswith(parent_id):
            child_ids.add(child_id)

    # Determine if we should add a number or letter based on parent_id
    if parent_id[-1].isdigit():
        # Parent ends in number, add letters
        used_letters = {child_id[len(parent_id)]
                       for child_id in child_ids
                       if len(child_id) > len(parent_id)}

        # Find first unused letter (a-z)
        for letter in 'abcdefghijklmnopqrstuvwxyz':
            if letter not in used_letters:
                return f"{parent_id}{letter}"

        raise ValueError(f"No available letter suffixes for parent {parent_id}")

    else:
        # Parent ends in letter (or is root), add two-digit numbers
        used_numbers = {child_id[len(parent_id):len(parent_id)+2]
                       for child_id in child_ids
                       if len(child_id) >= len(parent_id) + 2}

        # Find first unused two-digit number
        for i in range(1, 100):
            candidate = f"{i:02d}"
            if candidate not in used_numbers:
                return f"{parent_id}{candidate}"

        raise ValueError(f"No available number suffixes for parent {parent_id}")
