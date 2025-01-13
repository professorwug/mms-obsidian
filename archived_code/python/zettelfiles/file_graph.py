import os
import logging
from collections import defaultdict
from typing import Dict, Set
from watchdog.events import FileSystemEvent
from .get_hierarchy import build_combined_graph, GraphNode

class FileGraph:
    def __init__(self):
        self.surrogate_nodes = set()
        self.edges: Dict[str, Set[str]] = defaultdict(set)
        self.all_nodes: Set[str] = set()
        self.folgezettel_ids: Dict[str, str] = {}  # stable_id -> folgezettel_id
        self.names: Dict[str, str] = {}  # stable_id -> name
        self.paths: Dict[str, str] = {}  # stable_id -> path
        self.extensions: Dict[str, str] = {}  # stable_id -> extension
        self.folder_nodes: Set[str] = set()  # stable_ids of directory nodes

    def build_from_directory(self, directory: str):
        """Build graph from directory structure using get_hierarchy implementation"""
        self.__init__()  # Reset the graph

        # Get combined graph from get_hierarchy
        combined_graph = build_combined_graph(directory)

        # Convert the combined graph format to our internal format
        for stable_id, node_data in combined_graph["nodes"].items():
            self.all_nodes.add(stable_id)
            if node_data["id"]:  # Store Folgezettel ID if present
                self.folgezettel_ids[stable_id] = node_data["id"]
            self.names[stable_id] = node_data["name"]
            self.paths[stable_id] = node_data["path"]
            self.extensions[stable_id] = node_data["extension"]

            # Mark surrogate nodes
            if stable_id.startswith("surrogate_"):
                self.surrogate_nodes.add(stable_id)

            # Mark folder nodes
            if node_data.get("is_directory", False):
                self.folder_nodes.add(stable_id)

        # Convert edges (already using stable IDs)
        self.edges = combined_graph["edges"]

    def update_from_change(self, event: FileSystemEvent):
        # Handle file system changes
        pass

    def to_dict(self):
        """Convert graph to dictionary format for API/testing"""
        return {
            "nodes": {
                stable_id: {
                    "id": self.folgezettel_ids.get(stable_id, ""),
                    "name": self.names.get(stable_id, ""),
                    "path": self.paths.get(stable_id, ""),
                    "extension": self.extensions.get(stable_id, ""),
                    "is_directory": stable_id in self.folder_nodes
                }
                for stable_id in sorted(self.all_nodes)
            },
            "edges": {k: sorted(list(v)) for k, v in self.edges.items()},  # Convert set to sorted list
            "id_nodes": list(self.folgezettel_ids.keys()),  # Convert set to list 
            "folder_nodes": list(self.folder_nodes)  # Convert set to list
        }
    def node_props(self, stable_id):
        return {
            "id": self.folgezettel_ids.get(stable_id, ""),
            "name": self.names.get(stable_id, ""),
            "path": self.paths.get(stable_id, ""),
            "extension": self.extensions.get(stable_id, ""),
            "is_directory": stable_id in self.folder_nodes
        }

    @property
    def nodes(self):
        """Property for backward compatibility with tests"""
        return self.to_dict()["nodes"]
