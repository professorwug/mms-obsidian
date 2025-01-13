from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler, FileSystemEvent
from .file_graph import FileGraph
import asyncio
from typing import Callable, Optional

class GraphManager:
    def __init__(self):
        self.graph = None
        self.observer = None
        self.base_dir = None
        self.update_callback = None
    
    def initialize_graph(self, directory: str) -> FileGraph:
        self.base_dir = directory
        self.graph = FileGraph()
        self.graph.build_from_directory(directory)
        return self.graph
    
    def update_graph(self):
        """Force a graph update and notify callback"""
        if self.base_dir:
            self.graph.build_from_directory(self.base_dir)
            if self.update_callback:
                asyncio.create_task(self.update_callback(self.graph))
    
    def watch_directory(self, directory: str, callback: Callable):
        """Set up directory watching with callback for graph updates"""
        self.update_callback = callback
        
        class Handler(FileSystemEventHandler):
            def on_any_event(self2, event: FileSystemEvent):
                if event.is_directory:
                    return
                # Update graph and notify
                self.graph.update_from_change(event)
                if self.update_callback:
                    asyncio.create_task(self.update_callback(self.graph))
        
        if self.observer:
            self.observer.stop()
        
        self.observer = Observer()
        self.observer.schedule(Handler(), directory, recursive=True)
        self.observer.start()
