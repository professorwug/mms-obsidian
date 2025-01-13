import sys
import json
import os
import logging
import hashlib
from .utils import is_valid_node_id, get_parent_id, validate_node
from collections import defaultdict

def get_file_creation_time(path: str) -> str:
    """Get file creation time with nanosecond precision as a string"""
    stat = os.stat(path)
    # Use the earliest time we can find (creation time on Windows, earliest of ctime/mtime on Unix)
    creation_time = min(stat.st_ctime_ns, stat.st_mtime_ns)
    # Return nanosecond timestamp as string
    return str(creation_time)

def get_dir_hash(path: str) -> str:
    """Get stable hash of directory path"""
    return hashlib.md5(path.encode()).hexdigest()

# Configure logging
logging.basicConfig(level=logging.INFO)

# Define supported file types
SUPPORTED_EXTENSIONS = {'.md', '.txt', '.nb', '.pdf'}

class GraphNode:
    __slots__ = ['name', 'path', 'is_directory', 'id', 'extension', 'is_surrogate']

    def __init__(self, name, path, is_directory=False, is_surrogate=False):
        self.name = name
        self.path = os.path.normpath(path)
        self.is_directory = is_directory
        self.id = ""  # Will be populated for ID-based files
        self.extension = ""  # For files only
        self.is_surrogate = is_surrogate

def build_combined_graph(directory: str) -> dict:
    """
    Build a combined graph that includes both ID and non-ID hierarchies.

    Args:
        directory (str): Path to the root directory

    Returns:
        dict: {
            'nodes': dict[str, dict],  # path -> node data
            'edges': dict[str, set],   # parent -> children
            'id_nodes': set[str],      # IDs of nodes
            'folder_nodes': set[str]   # paths of folder nodes
        }

    Raises:
        ValueError: If directory doesn't exist or isn't a directory
        OSError: If there are permission issues
    """
    if not os.path.exists(directory):
        raise ValueError(f"Directory does not exist: {directory}")
    if not os.path.isdir(directory):
        raise ValueError(f"Path is not a directory: {directory}")

    logging.info(f"Building combined graph for directory: {directory}")
    nodes = {}  # path -> GraphNode
    seen_paths = set()
    parent_cache = {}

    def process_directory(current_dir, relative_path=""):
        logging.debug(f"Processing directory: {current_dir}")
        logging.debug(f"Relative path: {relative_path}")

        relative_path = os.path.normpath(relative_path)
        if relative_path in seen_paths:
            logging.warning(f"Skipping circular reference: {relative_path}")
            return
        seen_paths.add(relative_path)

        # Add node for current directory (except root)
        if relative_path:
            dir_name = os.path.basename(current_dir)
            node = GraphNode(dir_name, relative_path, is_directory=True)
            # Check for ID
            parts = dir_name.split(None, 1)
            if len(parts) > 1 and is_valid_node_id(parts[0]):
                node.id = parts[0]
                node.name = parts[1]
            else:
                node.name = dir_name

            # Use directory hash as stable ID
            node_key = f"dir_{get_dir_hash(current_dir)}"
            nodes[node_key] = node
            validate_node(nodes[node_key])

        # Get all entries first
        entries = os.listdir(current_dir)

        # Process all entries
        for entry in sorted(entries):
            full_path = os.path.join(current_dir, entry)
            entry_rel_path = os.path.join(relative_path, entry) if relative_path else entry

            if os.path.isdir(full_path):
                # For directories, use path hash as stable ID
                # node_key = f"dir_{get_dir_hash(full_path)}" # Not actually used
                process_directory(full_path, entry_rel_path)
            else:
                # For files, use creation time as stable ID
                node_key = get_file_creation_time(full_path)

                name, ext = os.path.splitext(entry)
                if ext.lower() not in SUPPORTED_EXTENSIONS:
                    logging.debug(f"Skipping unsupported file type: {entry}")
                    continue

                node = GraphNode(name, entry_rel_path)
                node.extension = ext
                logging.debug(f"Processing file: {entry_rel_path}")

                # Store Folgezettel ID if present, but don't use it as key
                parts = name.split(None, 1)
                if len(parts) > 1 and is_valid_node_id(parts[0]):
                    node.id = parts[0]
                    node.name = parts[1]
                else:
                    node.name = name

                # Store just the directory part of the path
                node.path = os.path.dirname(entry_rel_path)
                if node.path == '.':
                    node.path = ''

                nodes[node_key] = node

    # Start node creation
    process_directory(directory)

    # Phase 2: Create edges using stable IDs
    edges = defaultdict(set)
    id_nodes = set()
    folder_nodes = set()

    # Create a copy of nodes.items() to iterate over
    nodelist = list(nodes.items())
    for node_key, node in nodelist:
        # Track node types
        if node.is_directory:
            folder_nodes.add(node_key)
        if node.id:
            id_nodes.add(node_key)

        # Step 1: ID-based edges
        if node.id:
            parent_id = get_parent_id(node.id)
            if parent_id:
                # Find parent node by Folgezettel ID
                parent_key = next(
                    (k for k, n in nodes.items() if n.id == parent_id),
                    None
                )
                if parent_key:
                    edges[parent_key].add(node_key)
                else:
                    # Create surrogate with stable ID
                    surrogate_key = f"surrogate_{parent_id}"
                    surrogate = GraphNode(f"Surrogate {parent_id}", "", False)
                    surrogate.id = parent_id
                    nodes[surrogate_key] = surrogate
                    id_nodes.add(surrogate_key)
                    nodelist.append((surrogate_key, surrogate))
                    edges[surrogate_key].add(node_key)
                continue

        # Step 2: Folder-based edges (if no ID edge was created)
        if node.is_directory:
            parent_path = os.path.dirname(node.path)
        else:
            parent_path = node.path  # Use node.path directly - it's already the parent directory path

        if parent_path and parent_path not in ["", "."]:
            # Find parent node by path
            parent_key = next(
                (k for k, n in nodes.items() if n.is_directory and n.path == parent_path),
                None
            )
            if parent_key and parent_key != node_key:
                edges[parent_key].add(node_key)

    return {
        "nodes": {
            k: {
                "id": n.id,
                "name": n.name,
                "path": n.path,
                "extension": n.extension,
                "is_directory": n.is_directory,
                "is_surrogate": n.is_surrogate
            }
            for k, n in nodes.items()
        },
        "edges": edges,
        "id_nodes": id_nodes,
        "folder_nodes": folder_nodes
    }

def combined_graph_to_dict(graph):
    """Convert combined graph to a dictionary format suitable for JSON serialization"""
    return {
        "nodes": graph["nodes"],
        "edges": {k: sorted(list(v)) for k, v in graph["edges"].items()},
        "id_nodes": sorted(list(graph["id_nodes"])),
        "folder_nodes": sorted(list(graph["folder_nodes"]))
    }

if __name__ == "__main__":
    if len(sys.argv) > 1:
        directory = sys.argv[1]
        try:
            # Build combined graph
            combined_graph = build_combined_graph(directory)
            result = {
                "success": True,
                "data": combined_graph_to_dict(combined_graph)
            }
            print(json.dumps(result))
        except Exception as e:
            print(json.dumps({
                "success": False,
                "error": str(e),
                "data": None
            }))
    else:
        print(json.dumps({
            "success": False,
            "error": "No directory specified",
            "data": None
        }))
