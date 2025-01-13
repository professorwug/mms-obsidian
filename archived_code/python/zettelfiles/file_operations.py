import os
import shutil
import logging
from typing import List, Tuple, Dict
from .zettelrename import rename_and_update_links, find_links_to_file, update_links_in_file
from .utils import get_next_available_child_id
from .file_graph import FileGraph

def get_file_paths(base_dir: str, stable_ids: List[str], graph_data: dict) -> List[str]:
    """Get full file paths for multiple nodes using their stable IDs"""
    if isinstance(stable_ids, List):
        return [get_file_path(base_dir, stable_id, graph_data) for stable_id in stable_ids]
    else:
        return get_file_path(base_dir, stable_ids, graph_data)

def get_file_path(base_dir: str, stable_id: str, graph_data: dict) -> str:
    """Get full file path for a node using its stable ID"""
    node_data = graph_data.node_props(stable_id)

    # graph_data = graph_data.to_dict()
    # node_data = graph_data["nodes"].get(stable_id)
    if not node_data:
        raise ValueError(f"Node not found: {stable_id}")

    # Construct filename based on whether node has a Folgezettel ID
    if node_data["id"]:
        filename = f"{node_data['id']} {node_data['name']}{node_data['extension']}"
    else:
        filename = f"{node_data['name']}{node_data['extension']}"

    # Combine with path
    rel_path = os.path.join(node_data["path"] or "", filename)
    return os.path.join(base_dir, rel_path)

def get_file_paths_from_stable_ids(base_dir: str, stable_ids: List[str], graph_data: dict) -> List[str]:
    """Get full file paths for multiple nodes using their stable IDs"""
    return [get_file_paths(base_dir, stable_id, graph_data) for stable_id in stable_ids]

def move_files(
    base_dir: str,
    source_stable_ids: List[str],
    target_stable_id: str,
    graph: FileGraph
) -> Tuple[bool, List[str], FileGraph]:
    """
    Move files to target location and update their folgezettel IDs.

    Args:
        base_dir: Base directory of the zettelkasten
        source_stable_ids: List of stable IDs for source files to move
        target_stable_id: Stable ID of target node (file or directory)
        graph: Current graph state

    Returns:
        Tuple[bool, List[str], dict]:
            - Success flag
            - List of updated file paths
            - Updated graph
    """
    if not isinstance(source_stable_ids, List):
        source_stable_ids = [source_stable_ids]
    try:
        updated_files = set()
        print("whoop de do, I'm being moved")

        # Validate target exists
        if target_stable_id not in graph.all_nodes:
            raise ValueError(f"Target node not found: {target_stable_id}")

        # target_node = graph.all_nodes[target_stable_id]
        target_node = graph.node_props(target_stable_id)
        target_path = graph.paths[target_stable_id]
        # target_node['path'] if target_node['is_directory'] else os.path.dirname(target_node['path'])

        # Process each source file
        for source_stable_id in source_stable_ids:
            if source_stable_id not in graph.all_nodes:
                raise ValueError(f"Source node not found: {source_stable_id}")

            source_node = graph.node_props(source_stable_id) #graph['nodes'][source_stable_id]

            # Get current paths
            old_path = get_file_paths(base_dir, source_stable_id, graph)
            print("Old path is ",old_path, "stable id", source_stable_id)
            # Construct new path (initially without new ID)
            filename = os.path.basename(old_path)
            new_path = os.path.join(base_dir, target_path, filename)

            # First move the file to target directory if paths are different
            if old_path != new_path:
                os.makedirs(os.path.dirname(new_path), exist_ok=True)
                shutil.move(old_path, new_path)

            # Get new folgezettel ID if target has one
            if target_node.get('id'):
                new_id = get_next_available_child_id(graph.folgezettel_ids[target_stable_id], graph)
                if new_id:  # Only rename if we got a valid new ID
                    # Construct final path with new ID
                    new_filename = f"{new_id} {source_node['name']}{source_node['extension']}"
                    final_path = os.path.join(os.path.dirname(new_path), new_filename)

                    # Rename file and update links
                    success, affected_files = rename_and_update_links(
                        base_dir,
                        new_path,
                        final_path,
                        source_node['id'],
                        source_node['name'],
                        new_id,
                        source_node['name']
                    )

                    if success:
                        updated_files.update(affected_files)
                        print("adding ", affected_files, "to updated_files", updated_files)

                        # Update node in graph
                        # graph['nodes'][source_stable_id].update({
                        #     'id': new_id,
                        #     'path': target_path
                        # })
                        graph.folgezettel_ids[source_stable_id] = new_id
                        graph.paths[source_stable_id] = target_path
                    else:
                        raise Exception(f"Failed to rename {new_path} to {final_path}")
            else:
                # Just update the path in the graph
                # graph['nodes'][source_stable_id]['path'] = target_path
                graph.paths[source_stable_id] = target_path

            # Update edges in graph
            # Remove from old parent
            old_parent = next((pid for pid, children in graph.edges.items()
                             if source_stable_id in children), None)
            if old_parent:
                graph.edges[old_parent].remove(source_stable_id)
                # graph['edges'][old_parent].remove(source_stable_id)

            # Add to new parent
            graph.edges[target_stable_id].add(source_stable_id)

        return True, list(updated_files), graph

    except Exception as e:
        logging.error("Error during move operation: %s", e, exc_info=True)
        return False, [], graph

def delete_files(base_dir: str, stable_ids: List[str], graph_data: dict) -> Tuple[bool, List[str]]:
    """Delete files and update links"""
    try:
        deleted_files = []
        for stable_id in stable_ids:
            file_path = get_file_path(base_dir, stable_id, graph_data)
            os.remove(file_path)  # Or move to trash depending on implementation
            deleted_files.append(file_path)
        return True, deleted_files
    except Exception as e:
        logging.error("Error deleting files: %s", e)
        return False, []

def change_folgezettel_ids(
    base_dir: str,
    old_id: str,
    new_id: str,
    graph_data: dict
) -> Tuple[bool, List[str]]:
    """Change Folgezettel IDs for a node and its children"""
    try:
        updated_files = []

        # Find all affected nodes (node itself and children)
        affected_nodes = [
            stable_id for stable_id, node in graph_data["nodes"].items()
            if node["id"] and (
                node["id"] == old_id or
                (len(node["id"]) > len(old_id) and node["id"].startswith(old_id))
            )
        ]

        for stable_id in affected_nodes:
            node_data = graph_data["nodes"][stable_id]
            old_folgezettel_id = node_data["id"]
            new_folgezettel_id = new_id + old_folgezettel_id[len(old_id):] if len(old_folgezettel_id) > len(old_id) else new_id

            # Get paths
            old_path = get_file_path(base_dir, stable_id, graph_data)
            new_filename = f"{new_folgezettel_id} {node_data['name']}{node_data['extension']}"
            new_path = os.path.join(base_dir, node_data["path"] or "", new_filename)

            # Rename file and update links
            success, affected = rename_and_update_links(
                base_dir,
                old_path,
                new_path,
                old_folgezettel_id,
                node_data["name"],
                new_folgezettel_id,
                node_data["name"]
            )

            if success:
                updated_files.extend(affected)
            else:
                raise Exception(f"Failed to rename {old_path}")

        return True, list(set(updated_files))
    except Exception as e:
        logging.error("Error changing Folgezettel IDs: %s", e)
        return False, []

def create_file(path: str, content: str = "") -> bool:
    """Create a new file with optional content"""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    except Exception as e:
        logging.error("Error creating file: %s", e)
        return False

def get_obsidian_path(base_dir: str, stable_id: str, graph_data: dict) -> str:
    """Get the full path for opening a file in Obsidian"""
    node_data = graph_data["nodes"].get(stable_id)
    if not node_data:
        raise ValueError(f"Node not found: {stable_id}")

    # Construct filename based on whether node has a Folgezettel ID
    if node_data["id"]:
        filename = f"{node_data['id']} {node_data['name']}{node_data['extension']}"
    else:
        filename = f"{node_data['name']}{node_data['extension']}"

    # Combine with path
    rel_path = os.path.join(node_data["path"] or "", filename)
    return os.path.join(base_dir, rel_path)
