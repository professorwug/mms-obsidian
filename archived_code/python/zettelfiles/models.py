import os

class GraphNode:
    __slots__ = ['name', 'path', 'is_directory', 'id', 'extension', 'is_surrogate']
    
    def __init__(self, name, path, is_directory=False, is_surrogate=False):
        self.name = name
        self.path = os.path.normpath(path)
        self.is_directory = is_directory
        self.id = ""  # Will be populated for ID-based files
        self.extension = ""  # For files only
        self.is_surrogate = is_surrogate
