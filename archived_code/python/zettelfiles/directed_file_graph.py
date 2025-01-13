import os
import sys
import logging
from collections import defaultdict
from typing import Dict, Set, List
from models import GraphNode
from get_hierarchy import build_combined_graph, combined_graph_to_dict, get_file_creation_time
from utils import is_valid_node_id, get_parent_id, get_all_parent_ids, validate_node

class FileGraph:
    def __init__(self):
        self.surrogate_nodes = set()  # Track surrogate nodes
        self.edges: Dict[str, Set[str]] = defaultdict(set)
        self.all_nodes: Set[str] = set()
        self.ids: Dict[str, str] = {}  # id -> id (for consistency)
        self.names: Dict[str, str] = {}  # id -> name without id prefix
        self.paths: Dict[str, str] = {}  # id -> directory path only
        self.extensions: Dict[str, str] = {}  # id -> file extension (including dot)

    def ensure_node_exists(self, node_id: str, name: str = "", path: str = "", extension: str = "", is_surrogate: bool = False):
        """Creates node if it doesn't exist, updates info if provided"""
        if not node_id:  # Prevent empty node_id
            return

        self.all_nodes.add(node_id)
        self.ids[node_id] = node_id

        if is_surrogate:
            self.surrogate_nodes.add(node_id)

        # Only update other fields if not a surrogate or if values are provided
        if not is_surrogate or name:
            if name:
                self.names[node_id] = name.replace(node_id + " ", "", 1)
            if path:
                self.paths[node_id] = path
            if extension:
                self.extensions[node_id] = extension

    def add_edge(self, parent: str, child: str, child_name: str, child_path: str):
        self.edges[parent].add(child)
        self.ensure_node_exists(parent)
        self.ensure_node_exists(child, child_name, child_path)

    def get_full_name(self, node_id: str) -> str:
        """Returns the complete filename (id + name)"""
        if node_id not in self.names:
            return node_id
        return f"{node_id} {self.names[node_id]}"

    def get_full_path(self, node_id: str) -> str:
        """Returns the complete filepath (path + filename)"""
        if node_id not in self.paths:
            return ""
        path = self.paths[node_id]
        full_name = self.get_full_name(node_id)
        return os.path.join(path, full_name) if path else full_name

    def get_roots(self) -> Set[str]:
        """Find nodes that have no parents"""
        # Get all nodes that are children
        children = set()
        for child_set in self.edges.values():
            children.update(child_set)

        # Roots are nodes that are not children of any other node
        # and are exactly 2 characters long (root level)
        roots = {node for node in self.all_nodes
                if len(node) == 2 and node not in children}
        return roots

    def get_next_available_id(self, parent_id: str) -> str:
        """Returns the next available child ID for a parent"""
        # Get all existing children
        children = self.edges.get(parent_id, set())
        
        # If parent already has a letter suffix (e.g., "01a"), continue numeric sequence
        if len(parent_id) > 2 and not parent_id[-1].isdigit():
            # Get existing numeric suffixes
            used_nums = {int(child_id[len(parent_id):]) for child_id in children
                        if len(child_id) > len(parent_id) 
                        and child_id.startswith(parent_id)
                        and child_id[len(parent_id):].isdigit()}
            
            # Find next available number
            next_num = 1
            while next_num <= 99:
                if next_num not in used_nums:
                    return f"{parent_id}{next_num:02d}"
                next_num += 1
        
        # For root-level parents (e.g., "00", "01"), try letters first
        used_letters = {child_id[len(parent_id)] for child_id in children
                       if len(child_id) == len(parent_id) + 1 
                       and child_id.startswith(parent_id)}
        
        # Try letters a through z
        for letter in 'abcdefghijklmnopqrstuvwxyz':
            if letter not in used_letters:
                return f"{parent_id}{letter}"
        
        # If all letters are used, fall back to numbered sequence
        used_nums = {int(child_id[len(parent_id):]) for child_id in children
                    if len(child_id) > len(parent_id) 
                    and child_id.startswith(parent_id)
                    and child_id[len(parent_id):].isdigit()}
        
        next_num = 1
        while next_num <= 99:
            if next_num not in used_nums:
                return f"{parent_id}{next_num:02d}"
            next_num += 1
        
        raise ValueError(f"No available IDs for parent {parent_id}")

    def print_hierarchy(self, node: str = None, depth: int = 0):
        if node is None:
            for root in sorted(self.get_roots()):
                self.print_hierarchy(root, 0)
            return

        # Show full name, then path in brackets
        full_name = self.get_full_name(node)
        path = self.paths.get(node, '')
        logging.debug("  " * depth + f"{full_name} [{path}]")
        for child in sorted(self.edges[node]):
            self.print_hierarchy(child, depth + 1)


# def get_file_creation_time(filepath: str) -> float:
#     """Get file creation time (or earliest available timestamp)"""
#     stats = os.stat(filepath)
#     # Try to get creation time, fall back to earliest available time
#     # Different platforms handle this differently
#     creation_time = min(
#         stats.st_ctime,  # Creation time on Windows, metadata change time on Unix
#         stats.st_mtime,  # Modification time
#         stats.st_atime   # Access time
#     )
#     return creation_time

def adopt_orphans(graph: FileGraph, directory: str) -> None:
    """Process orphaned files in the directory"""
    from zettelrename import update_links_in_file  # Import the link updater
    import re

    def sanitize_filename(filename: str) -> str:
        """Sanitize filename while preserving extension"""
        name, ext = os.path.splitext(filename)
        # Replace problematic characters with underscores
        sanitized = re.sub(r'[,;!@#$%]', '_', name)
        # Replace dots and spaces with single underscore
        sanitized = re.sub(r'[\s.]+', '_', sanitized)
        return sanitized + ext

    def get_all_files(dir_path: str) -> List[tuple[str, str]]:
        """Returns list of (filepath, relative_path) for all files"""
        result = []
        for root, _, files in os.walk(dir_path):
            rel_path = os.path.relpath(root, dir_path)
            if rel_path == '.':
                rel_path = ''
            for file in files:
                result.append((
                    os.path.join(root, file),
                    rel_path
                ))
        return result

    def ensure_inbox_exists(base_dir: str) -> str:
        """Ensures the Inbox folder exists and returns its path"""
        inbox_path = os.path.join(base_dir, "00 Inbox")
        if not os.path.exists(inbox_path):
            os.makedirs(inbox_path)
            # Add inbox node to graph
            graph.ensure_node_exists("00", "Inbox", "", "")
        return inbox_path

    def handle_duplicate_id(original_id: str) -> str:
        """Generate new ID for duplicate file by alternating between adding '00' and '_'"""
        new_id = original_id
        while new_id in graph.all_nodes:
            if new_id[-1].isdigit():
                # If ends in digit, append underscore
                new_id = f"{new_id}_"
            else:
                # If ends in non-digit (letter or underscore), append 00
                new_id = f"{new_id}00"
        return new_id


    def get_file_id_map(files):
        """Create a map of file IDs to their full paths to detect duplicates, sorted by creation time"""
        id_map = {}
        for filepath, _ in files:
            filename = os.path.basename(filepath)
            base_name = os.path.splitext(filename)[0]
            file_id = base_name.split()[0] if ' ' in base_name else ''

            if is_valid_node_id(file_id):
                if file_id not in id_map:
                    id_map[file_id] = []
                # Store tuple of (creation_time, filepath)
                id_map[file_id].append((get_file_creation_time(filepath), filepath))

        # Sort each list by creation time
        for file_id in id_map:
            id_map[file_id].sort()  # Will sort by creation_time since it's first in tuple
            # Convert back to just filepaths
            id_map[file_id] = [filepath for _, filepath in id_map[file_id]]
        return id_map

    # Get all files in directory
    all_files = get_all_files(directory)
    id_map = get_file_id_map(all_files)

    # First check if we have any files that need processing
    needs_inbox = False
    for filepath, rel_path in all_files:
        filename = os.path.basename(filepath)
        base_name = os.path.splitext(filename)[0]
        file_id = base_name.split()[0] if ' ' in base_name else ''

        # Skip if file is already properly in graph (not a duplicate)
        if file_id in graph.all_nodes and len(id_map.get(file_id, [])) <= 1:
            continue

        # Get parent directory's ID
        parent_path = os.path.dirname(filepath)
        parent_name = os.path.basename(parent_path)
        parent_id = parent_name.split()[0] if ' ' in parent_name else ''

        if not is_valid_node_id(file_id):
            if not (parent_id and is_valid_node_id(parent_id)):
                needs_inbox = True
                break

    # Only create inbox if needed
    inbox_path = ensure_inbox_exists(directory) if needs_inbox else None

    # Process duplicates first
    for file_id, filepaths in id_map.items():
        if len(filepaths) > 1:  # We have duplicates
            # filepaths is now sorted by creation time
            original_path = filepaths[0]  # Oldest file becomes the original
            for filepath in filepaths[1:]:  # Process newer files as duplicates
                filename = os.path.basename(filepath)
                base_name = os.path.splitext(filename)[0]
                extension = os.path.splitext(filename)[1]

                new_id = handle_duplicate_id(file_id)
                new_name = f"{new_id} {base_name.replace(file_id, '', 1).strip()}"
                new_filepath = os.path.join(os.path.dirname(filepath), new_name + extension)

                logging.info(f"Processing duplicate: {filepath}")
                logging.info(f"Original file: {original_path}")
                logging.info(f"New name: {new_name}")

                # Update links and rename
                update_links_in_file(filepath, file_id, base_name, new_id, new_name)
                os.rename(filepath, new_filepath)

                # Update graph
                graph.ensure_node_exists(
                    new_id,
                    new_name,
                    os.path.relpath(os.path.dirname(new_filepath), directory),
                    extension
                )

    # Process remaining files
    for filepath, rel_path in all_files:
        filename = os.path.basename(filepath)
        base_name = os.path.splitext(filename)[0]
        extension = os.path.splitext(filename)[1]

        # Skip if file is already in graph
        file_id = base_name.split()[0] if ' ' in base_name else ''
        if file_id in graph.all_nodes:
            continue

        # Get parent directory's ID
        parent_path = os.path.dirname(filepath)
        parent_name = os.path.basename(parent_path)
        parent_id = parent_name.split()[0] if ' ' in parent_name else ''

        new_id = None
        new_path = None

        if not is_valid_node_id(file_id):
            # Case 1: No valid ID
            if parent_id and is_valid_node_id(parent_id):
                # Use parent's ID as prefix
                new_id = graph.get_next_available_id(parent_id)
            else:
                # Move to inbox
                new_id = graph.get_next_available_id("00")
                new_path = inbox_path
        else:
            # Case 2: Duplicate ID
            new_id = handle_duplicate_id(file_id)
            # Get original node's path
            original_path = graph.paths.get(file_id, '')
            new_path = os.path.dirname(graph.get_full_path(file_id))

        if new_id:
            # Construct new filename and path
            clean_name = sanitize_filename(base_name.replace(file_id, '', 1).strip() if file_id else base_name)
            new_name = f"{new_id} {clean_name}"
            new_filepath = os.path.join(new_path or parent_path, new_name + extension)

            # Update links before moving/renaming
            update_links_in_file(filepath, file_id, base_name, new_id, new_name)

            # Move/rename file
            os.rename(filepath, new_filepath)

            # Update graph
            graph.ensure_node_exists(
                new_id,
                new_name,
                os.path.relpath(os.path.dirname(new_filepath), directory),
                extension
            )

            # Add edge from parent
            parent_id = get_parent_id(new_id)
            if parent_id:
                graph.edges[parent_id].add(new_id)

def validate_node(node: GraphNode) -> None:
    """Validate node data consistency"""
    if node.is_directory and node.extension:
        logging.warning(f"Directory node has extension: {node.path}")
    if node.id and not is_valid_node_id(node.id):
        logging.warning(f"Invalid node ID: {node.id}")

def validate_edges(edges: dict, nodes: dict) -> None:
    """Validate edge consistency"""
    for parent, children in edges.items():
        if parent not in nodes:
            logging.error(f"Edge references missing parent: {parent}")
        for child in children:
            if child not in nodes:
                logging.error(f"Edge references missing child: {child}")

def cleanup_graph(graph: dict) -> None:
    """Remove any orphaned nodes or invalid edges"""
    nodes = graph['nodes']
    edges = graph['edges']
    
    # Remove edges to non-existent nodes
    for parent in list(edges.keys()):
        if parent not in nodes:
            del edges[parent]
        else:
            edges[parent] = {child for child in edges[parent] if child in nodes}

# def build_graph_from_directory(directory: str) -> FileGraph:
#     graph = FileGraph()
#     
#     def ensure_parent_chain(node_id: str):
#         """Ensures all parent nodes exist in the graph, as surrogates by default"""
#         parents = get_all_parent_ids(node_id)
# 
#         # Create all parent nodes and establish edges
#         current_id = node_id
#         for parent_id in reversed(parents):  # Process from root down
#             graph.ensure_node_exists(parent_id, "", "", "", is_surrogate=True)
# 
#             # Get the immediate child for this parent
#             child_id = current_id[:len(parent_id) + (3 if len(parent_id) == 2 else 2)]
#             if child_id in graph.all_nodes:
#                 graph.edges[parent_id].add(child_id)
#             current_id = parent_id
# 
#     def print_graph_state(graph, message):
#         """Helper function to print current graph state"""
#         logging.debug(f"\n=== Graph State: {message} ===")
#         logging.debug("Nodes:")
#         for node in sorted(graph.all_nodes):
#             logging.debug(f"  {node}:")
#             logging.debug(f"    Name: {graph.names.get(node, '<none>')}")
#             logging.debug(f"    Path: {graph.paths.get(node, '<none>')}")
#             logging.debug(f"    Ext:  {graph.extensions.get(node, '<none>')}")
#             logging.debug(f"    Is Surrogate: {node in graph.surrogate_nodes}")
# 
#         logging.debug("\nEdges:")
#         for parent in sorted(graph.edges.keys()):
#             children = sorted(graph.edges[parent])
#             logging.debug(f"  {parent} -> {children}")
# 
#     def process_directory(current_dir: str, relative_path: str = ""):
#         # Get sorted entries by creation time
#         entries = [(get_file_creation_time(os.path.join(current_dir, entry)), entry)
#                   for entry in os.listdir(current_dir)]
#         entries.sort()  # Sort by creation time
#         entries = [entry for _, entry in entries]  # Extract just the names
# 
#         logging.debug(f"\n=== Processing Directory ===")
#         logging.debug(f"Current dir: {current_dir}")
#         logging.debug(f"Relative path: {relative_path}")
#         logging.debug(f"Entries found: {len(entries)}")
# 
#         # Process all entries in a single loop
#         for entry in sorted(entries):
#             full_path = os.path.join(current_dir, entry)
#             is_dir = os.path.isdir(full_path)
# 
#             logging.debug(f"\n--- Processing {'Directory' if is_dir else 'File'} Entry: {entry} ---")
# 
#             # Get base name and extension (extension will be empty for directories)
#             base_name = entry if is_dir else os.path.splitext(entry)[0]
#             extension = '' if is_dir else os.path.splitext(entry)[1]
# 
#             parts = base_name.split(None, 1)
# 
#             if len(parts) < 1 or not is_valid_node_id(parts[0]):
#                 logging.debug(f"Skipping invalid {'directory' if is_dir else 'file'} name: {entry}")
#                 continue
# 
#             current_id = parts[0]
#             logging.debug(f"{'Directory' if is_dir else 'File'} ID: {current_id}")
# 
#             # Create node and its parent chain
#             parent_chain = get_all_parent_ids(current_id)
#             logging.debug(f"Parent chain: {parent_chain}")
# 
#             for parent_id in reversed(parent_chain):
#                 graph.ensure_node_exists(parent_id, "", "", "", is_surrogate=True)
#                 logging.debug(f"Created surrogate parent: {parent_id}")
# 
#             # Create the node
#             graph.ensure_node_exists(
#                 current_id,
#                 base_name,
#                 relative_path,
#                 extension,
#                 is_surrogate=False
#             )
#             logging.debug(f"Created {'directory' if is_dir else 'file'} node: {current_id}")
# 
#             # Establish edges from parent to child (not child to parent)
#             full_chain = [current_id] + parent_chain
#             for i in range(len(full_chain) - 1):
#                 child_id = full_chain[i]
#                 parent_id = full_chain[i + 1]
#                 # Connect parent to child (not child to parent)
#                 graph.edges[parent_id].add(child_id)
#                 logging.debug(f"Added edge: {parent_id} -> {child_id}")
# 
#             print_graph_state(graph, f"After processing {'directory' if is_dir else 'file'} {entry}")
# 
#             # Recursively process directory contents
#             if is_dir:
#                 new_rel_path = os.path.join(relative_path, entry)
#                 process_directory(full_path, new_rel_path)
#     process_directory(directory)
#     return graph

def graph_to_dict(graph):
    """Convert graph to a dictionary format suitable for JSON serialization"""
    logging.debug("=== Debug: Converting graph to dict ===")

    nodes_data = {}
    for node_id in sorted(graph.all_nodes):
        # For all nodes, include their data - surrogates will have empty strings
        nodes_data[node_id] = {
            'name': graph.names.get(node_id, ''),
            'path': graph.paths.get(node_id, ''),
            'extension': graph.extensions.get(node_id, '')
        }
        logging.debug(f"Node {node_id}:")
        logging.debug(f"  Name: {nodes_data[node_id]['name']}")
        logging.debug(f"  Path: {nodes_data[node_id]['path']}")
        logging.debug(f"  Ext:  {nodes_data[node_id]['extension']}")

    return {
        'nodes': nodes_data,
        'edges': {k: sorted(list(v)) for k, v in graph.edges.items()}
    }

# class NonIdFileGraph:
#     def __init__(self):
#         self.nodes = {}  # path -> {name, is_directory}
#         self.edges = defaultdict(set)  # parent_path -> set of child_paths

# def build_non_id_graph(directory: str) -> NonIdFileGraph:
#     graph = NonIdFileGraph()
#     
#     def process_non_id_entry(full_path: str, rel_path: str):
#         name = os.path.basename(full_path)
#         # Skip files/folders that have valid node IDs
#         if ' ' in name and is_valid_node_id(name.split()[0]):
#             return
#             
#         is_dir = os.path.isdir(full_path)
#         graph.nodes[rel_path] = {
#             'name': name,
#             'is_directory': is_dir
#         }
#         
#         # Add edge from parent
#         parent_path = os.path.dirname(rel_path)
#         if parent_path:
#             graph.edges[parent_path].add(rel_path)
#             
#         # Recursively process directory contents
#         if is_dir:
#             for entry in os.listdir(full_path):
#                 child_full_path = os.path.join(full_path, entry)
#                 child_rel_path = os.path.join(rel_path, entry)
#                 process_non_id_entry(child_full_path, child_rel_path)
#     
#     process_non_id_entry(directory, '')
#     return graph
# 
# def non_id_graph_to_dict(graph: NonIdFileGraph):
#     return {
#         'nodes': graph.nodes,
#         'edges': {k: list(v) for k, v in graph.edges.items()}
#     }

if __name__ == "__main__":
    import json
    import logging
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument('directory', help='Directory to process')
    parser.add_argument('--include-non-id', action='store_true', 
                       help='Include files/folders without valid node IDs')
    args = parser.parse_args()

    try:
        # Build combined graph
        combined_graph = build_combined_graph(args.directory)
        result = {
            "success": True,
            "data": combined_graph_to_dict(combined_graph)
        }
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e)
        }))
