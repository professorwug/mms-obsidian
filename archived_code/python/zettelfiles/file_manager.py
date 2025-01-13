from typing import List, Tuple, Optional
from .file_operations import move_files, get_file_path, create_file
from .zettelrename import rename_and_update_links, find_links_to_file
from .graph_manager import GraphManager
from .atomic_ops import AtomicFileOps
from .get_hierarchy import get_file_creation_time
import os
import logging
from tkinter.constants import TOP

class FileManager:
    def __init__(self, graph_manager: GraphManager):
        self.graph_manager = graph_manager
        self.atomic_ops = AtomicFileOps()

    async def move_files(
        self,
        source_stable_ids: List[str],
        target_stable_id: str
    ) -> Tuple[bool, List[str]]:
        """Move files and update graph using stable IDs"""
        print(f"FileManager.move_files called with sources={source_stable_ids}, target={target_stable_id}")
        if not self.graph_manager.base_dir:
            raise ValueError("No base directory set")

        try:
            print(f"Using base_dir: {self.graph_manager.base_dir}")
            print(f"Current graph state: {self.graph_manager.graph}")

            # Update graph before any operations
            self.graph_manager.update_graph()

            # Convert paths to stable IDs
            if not isinstance(source_stable_ids, List):
                source_stable_ids = [source_stable_ids]

            # Convert source paths to stable IDs
            converted_source_ids = []
            for source_id in source_stable_ids:
                if os.path.exists(source_id):
                    rel_path = os.path.relpath(source_id, self.graph_manager.base_dir)
                    # Get file creation time as stable ID
                    source_stable_id = get_file_creation_time(source_id)
                    if source_stable_id not in self.graph_manager.graph.nodes:
                        # Try updating the graph again
                        self.graph_manager.update_graph()
                        if source_stable_id not in self.graph_manager.graph.nodes:
                            raise ValueError(f"Source file not found in graph: {rel_path}")
                    converted_source_ids.append(source_stable_id)
                else:
                    # Check if the ID exists in the graph
                    if source_id not in self.graph_manager.graph.nodes:
                        raise ValueError(f"Source ID not found in graph: {source_id}")
                    converted_source_ids.append(source_id)

            # Convert target path to stable ID
            if os.path.exists(target_stable_id):
                rel_path = os.path.relpath(target_stable_id, self.graph_manager.base_dir)
                target_id = next(
                    (k for k, n in self.graph_manager.graph.nodes.items()
                     if n.get('is_directory', False) and n.get('path', '') == rel_path),
                    None
                )
                if not target_id:
                    # If target directory doesn't exist in graph, update the graph
                    self.graph_manager.update_graph()
                    # Try finding the directory again
                    target_id = next(
                        (k for k, n in self.graph_manager.graph.nodes.items()
                         if n.get('is_directory', False) and n.get('path', '') == rel_path),
                        None
                    )
                    if not target_id:
                        return False, []  # Target directory not found
                target_stable_id = target_id
            else:
                # Check if the target ID exists in the graph
                if target_stable_id not in self.graph_manager.graph.nodes:
                    return False, []  # Target ID not found
            
            # Use new move_files implementation
            success, updated_files, updated_graph = move_files(
                self.graph_manager.base_dir,
                converted_source_ids,
                target_stable_id,
                self.graph_manager.graph
            )

            print(f"move_files result: success={success}, updated_files={updated_files}")

            if success:
                # Update the graph manager with new graph state
                self.graph_manager.graph = updated_graph
                # Trigger graph update to ensure consistency
                self.graph_manager.update_graph()

            return success, updated_files

        except Exception as e:
            logging.error("Error during move operation: %s", e)
            if isinstance(e, ValueError):
                raise
            return False, []

    async def rename_file(
        self,
        old_path: str,
        new_path: str
    ) -> Tuple[bool, List[str]]:
        """Rename file atomically and update graph"""
        if not self.graph_manager.base_dir:
            raise ValueError("No base directory set")

        if not old_path or not new_path:
            raise ValueError("Invalid file path")

        try:
            old_name = os.path.splitext(os.path.basename(old_path))[0]
            new_name = os.path.splitext(os.path.basename(new_path))[0]
            old_parts = old_name.split(' ', 1)
            new_parts = new_name.split(' ', 1)
            print(f"Renaming file with stuff: {old_name, new_name, old_parts, new_parts}")
            success, updated_files = rename_and_update_links(
                self.graph_manager.base_dir,
                old_path,
                new_path,
                old_parts[0],
                old_parts[1] if len(old_parts) > 1 else "",
                new_parts[0],
                new_parts[1] if len(new_parts) > 1 else ""
            )

            if success:
                self.graph_manager.update_graph()

            return success, updated_files
        except Exception as e:
            logging.error("Error during rename operation: %s", e)
            if isinstance(e, ValueError):
                raise
            return False, []

    async def create_file(
        self,
        file_path: str,
        content: str = ""
    ) -> Tuple[bool, List[str]]:
        """Create a new file atomically and update graph"""
        if not self.graph_manager.base_dir:
            raise ValueError("No base directory set")

        if not file_path:
            raise ValueError("Invalid file path")

        try:
            success, updated_files = self.atomic_ops.atomic_create(
                file_path,
                content
            )

            if success:
                self.graph_manager.update_graph()

            return success, updated_files
        except Exception as e:
            logging.error("Error in atomic create: %s", e)
            if isinstance(e, ValueError):
                raise
            return False, []
