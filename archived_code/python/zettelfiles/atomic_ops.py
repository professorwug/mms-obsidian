import os
import shutil
import threading
import logging
from typing import List, Tuple, Optional, Callable
from contextlib import contextmanager
from pathlib import Path

class AtomicFileOps:
    def __init__(self):
        self._file_locks = {}
        self._locks_lock = threading.Lock()
        self._global_lock = threading.Lock()
    
    @contextmanager
    def _get_file_lock(self, filepath: str):
        """Get or create a lock for a specific file"""
        with self._locks_lock:
            if filepath not in self._file_locks:
                self._file_locks[filepath] = threading.Lock()
            lock = self._file_locks[filepath]
        
        try:
            lock.acquire()
            yield
        finally:
            lock.release()
            # Clean up lock if no longer needed
            with self._locks_lock:
                if filepath in self._file_locks and not lock.locked():
                    del self._file_locks[filepath]

    def atomic_move(
        self,
        source_paths: List[str],
        target_dir: str,
        update_func: Optional[Callable] = None
    ) -> Tuple[bool, List[str]]:
        """
        Atomically move files and perform updates
        """
        # Sort paths to prevent deadlocks
        sorted_paths = sorted(source_paths)
        affected_files = []
        
        # Acquire locks in order
        locks_acquired = []
        try:
            # First lock target directory
            target_lock = self._get_file_lock(target_dir)
            target_lock.__enter__()
            locks_acquired.append(target_lock)
            
            # Then lock each source file
            for path in sorted_paths:
                lock = self._get_file_lock(path)
                lock.__enter__()
                locks_acquired.append(lock)
            
            # Perform the move operation
            try:
                os.makedirs(target_dir, exist_ok=True)
                
                # Move each file
                for source_path in sorted_paths:
                    target_path = os.path.join(target_dir, os.path.basename(source_path))
                    shutil.move(source_path, target_path)
                    affected_files.append(target_path)
                
                # Perform any additional updates
                if update_func:
                    update_func(affected_files)
                
                return True, affected_files
                
            except Exception as e:
                logging.error(f"Error in atomic move: {e}")
                # Attempt to rollback moves
                self._rollback_moves(affected_files, sorted_paths)
                return False, []
                
        finally:
            # Release all locks in reverse order
            for lock in reversed(locks_acquired):
                lock.__exit__(None, None, None)

    def atomic_rename(
        self,
        old_path: str,
        new_path: str,
        update_func: Optional[Callable] = None
    ) -> Tuple[bool, List[str]]:
        """
        Atomically rename a file and perform updates
        """
        affected_files = []
        locks_acquired = []
        
        try:
            # Lock both old and new paths
            for path in sorted([old_path, new_path]):
                lock = self._get_file_lock(path)
                lock.__enter__()
                locks_acquired.append(lock)
            
            try:
                # Perform rename
                os.rename(old_path, new_path)
                affected_files.append(new_path)
                
                # Perform any additional updates
                if update_func:
                    update_func([new_path])
                
                return True, affected_files
                
            except Exception as e:
                logging.error(f"Error in atomic rename: {e}")
                # Attempt to rollback rename
                if os.path.exists(new_path):
                    try:
                        os.rename(new_path, old_path)
                    except Exception as rollback_error:
                        logging.error(f"Error during rollback: {rollback_error}")
                return False, []
                
        finally:
            # Release locks in reverse order
            for lock in reversed(locks_acquired):
                lock.__exit__(None, None, None)

    def atomic_create(
        self,
        path: str,
        content: str = "",
        update_func: Optional[Callable] = None
    ) -> bool:
        """
        Atomically create a file and perform updates
        """
        with self._get_file_lock(path):
            try:
                # Ensure directory exists
                os.makedirs(os.path.dirname(path), exist_ok=True)
                
                # Create file
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(content)
                
                # Perform any additional updates
                if update_func:
                    update_func([path])
                
                return True
                
            except Exception as e:
                logging.error(f"Error in atomic create: {e}")
                # Attempt to rollback creation
                if os.path.exists(path):
                    try:
                        os.remove(path)
                    except Exception as rollback_error:
                        logging.error(f"Error during rollback: {rollback_error}")
                return False

    def _rollback_moves(self, moved_files: List[str], original_paths: List[str]):
        """Attempt to rollback moved files to their original locations"""
        for new_path, old_path in zip(moved_files, original_paths):
            if os.path.exists(new_path):
                try:
                    shutil.move(new_path, old_path)
                except Exception as e:
                    logging.error(f"Error during move rollback: {e}")
