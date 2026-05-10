/**
 * BookManager - 蔵書の CRUD 管理を担当するクラス
 * kindle.json からのインポート、手動追加、削除機能を提供
 */
class BookManager {
    constructor() {
        this.library = {
            books: [],
            metadata: {
                lastImportDate: null,
                totalBooks: 0,
                manuallyAdded: 0,
                importedFromKindle: 0
            }
        };
    }

    /**
     * ライブラリデータを初期化・読み込み
     */
    async initialize() {
        // まずLocalStorageから確認
        const savedLibrary = localStorage.getItem('virtualBookshelf_library');
        if (savedLibrary) {
            try {
                const parsedLibrary = JSON.parse(savedLibrary);
                // 後方互換性: 古い形式（asin）から新形式（bookId）に変換
                this.library = this.normalizeLibrary(parsedLibrary);
                // Data restored from localStorage
                return;
            } catch (error) {
                // LocalStorage loading error (fallback to file)
            }
        }

        // LocalStorageにない場合はlibrary.jsonを確認
        try {
            const response = await fetch('data/library.json');
            const libraryData = await response.json();
            // 新しいデータ構造から変換（後方互換性付き）
            this.library = {
                books: Object.entries(libraryData.books).map(([key, book]) => this.normalizeBook(book, key)),
                metadata: {
                    totalBooks: libraryData.stats?.totalBooks || Object.keys(libraryData.books).length,
                    manuallyAdded: 0,
                    importedFromKindle: libraryData.stats?.totalBooks || Object.keys(libraryData.books).length,
                    lastImportDate: libraryData.exportDate
                }
            };
            // Data loaded from library.json
        } catch (error) {
            // ファイルが存在しない場合は空の蔵書で初期化（自動インポートしない）
            // Initializing empty library (no library.json found)
            this.library = {
                books: [],
                metadata: {
                    totalBooks: 0,
                    manuallyAdded: 0,
                    importedFromKindle: 0,
                    lastImportDate: null
                }
            };
        }
    }

    /**
     * ライブラリ全体を正規化（後方互換性対応）
     */
    normalizeLibrary(library) {
        return {
            books: library.books.map(book => this.normalizeBook(book, null)),
            metadata: library.metadata
        };
    }

    /**
     * 書籍データを正規化（asin → bookId の後方互換性対応）
     */
    normalizeBook(book, key) {
        return {
            bookId: book.bookId || book.asin || key,  // bookId優先、なければasin、なければキー
            title: book.title,
            authors: book.authors,
            acquiredTime: book.acquiredTime,
            readStatus: book.readStatus,
            productImage: book.productImage,
            source: book.source,
            addedDate: book.addedDate,
            // 追加フィールドも含める
            ...(book.memo && { memo: book.memo }),
            ...(book.rating && { rating: book.rating }),
            ...(book.updatedBookId && { updatedBookId: book.updatedBookId }),
            ...(book.updatedAsin && { updatedBookId: book.updatedAsin }),  // 旧形式対応
            // TECHSHELFフィールド（optional）
            ...(book.level && { level: book.level }),
            ...(book.lang && { lang: book.lang }),
            ...(book.genre && { genre: book.genre })
        };
    }

    /**
     * kindle.jsonから初回データを移行
     */
    async initializeFromKindleData() {
        try {
            const response = await fetch('data/kindle.json');
            const kindleBooks = await response.json();

            this.library.books = kindleBooks.map(book => ({
                ...this.normalizeBook(book, book.asin),
                source: 'kindle_import',
                addedDate: Date.now()
            }));

            this.library.metadata = {
                lastImportDate: Date.now(),
                totalBooks: kindleBooks.length,
                manuallyAdded: 0,
                importedFromKindle: kindleBooks.length
            };

            await this.saveLibrary();
            // Kindle import completed
        } catch (error) {
            // Kindle.json loading error
        }
    }

    /**
     * kindle.jsonから新しいデータをインポート（重複チェック付き）
     */
    async importFromKindle(fileInput = null) {
        let kindleBooks;

        if (fileInput) {
            // ファイル入力からインポート
            const fileContent = await this.readFileContent(fileInput);
            kindleBooks = JSON.parse(fileContent);
        } else {
            // data/kindle.json からインポート
            const response = await fetch('data/kindle.json');
            kindleBooks = await response.json();
        }

        const importResults = {
            total: kindleBooks.length,
            added: 0,
            updated: 0,
            skipped: 0
        };

        for (const kindleBook of kindleBooks) {
            const bookId = kindleBook.bookId || kindleBook.asin;
            const existingBook = this.library.books.find(book => book.bookId === bookId);

            if (existingBook) {
                // 既存書籍の更新（新しい情報で上書き）
                if (this.shouldUpdateBook(existingBook, kindleBook)) {
                    Object.assign(existingBook, {
                        title: kindleBook.title,
                        authors: kindleBook.authors,
                        acquiredTime: kindleBook.acquiredTime,
                        readStatus: kindleBook.readStatus,
                        productImage: kindleBook.productImage
                    });
                    importResults.updated++;
                }
                else {
                    importResults.skipped++;
                }
            } else {
                // 新規書籍の追加
                this.library.books.push({
                    ...this.normalizeBook(kindleBook, bookId),
                    source: 'kindle_import',
                    addedDate: Date.now()
                });
                importResults.added++;
            }
        }

        // メタデータ更新
        this.library.metadata.lastImportDate = Date.now();
        this.library.metadata.totalBooks = this.library.books.length;
        this.library.metadata.importedFromKindle = this.library.books.filter(book => book.source === 'kindle_import').length;

        await this.saveLibrary();

        console.log('インポート結果:', importResults);
        return importResults;
    }

    async importSelectedBooks(selectedBooks) {
        const importedBooks = [];
        const duplicateBooks = [];
        const errorBooks = [];

        // 既存の本のbookIdを取得
        const existingBookIds = new Set(this.library.books.map(book => book.bookId));

        for (const book of selectedBooks) {
            try {
                const bookId = book.bookId || book.asin;
                // 重複チェック
                if (existingBookIds.has(bookId)) {
                    duplicateBooks.push({
                        title: book.title,
                        bookId: bookId,
                        reason: '既に存在'
                    });
                    continue;
                }

                // 本を追加
                const bookToAdd = {
                    ...this.normalizeBook(book, bookId),
                    source: 'kindle_import',
                    addedDate: Date.now()
                };

                this.library.books.push(bookToAdd);
                importedBooks.push(bookToAdd);

            } catch (error) {
                console.error(`本の処理エラー: ${book.title}`, error);
                errorBooks.push({
                    title: book.title,
                    bookId: book.bookId || book.asin,
                    reason: error.message
                });
            }
        }

        // メタデータを更新
        this.library.metadata = {
            totalBooks: this.library.books.length,
            manuallyAdded: this.library.books.filter(b => b.source === 'manual_add').length,
            importedFromKindle: this.library.books.filter(b => b.source === 'kindle_import').length,
            lastImportDate: Date.now()
        };

        // ライブラリを保存
        await this.saveLibrary();

        console.log(`選択インポート完了: ${importedBooks.length}件追加`);

        return {
            success: true,
            total: selectedBooks.length,
            added: importedBooks.length,
            updated: 0, // 選択インポートでは更新なし
            skipped: duplicateBooks.length + errorBooks.length,
            imported: importedBooks,
            duplicates: duplicateBooks,
            errors: errorBooks
        };
    }


    /**
     * 書籍更新が必要かチェック
     */
    shouldUpdateBook(existingBook, newBook) {
        return existingBook.acquiredTime !== newBook.acquiredTime ||
               existingBook.readStatus !== newBook.readStatus ||
               existingBook.title !== newBook.title ||
               existingBook.productImage !== newBook.productImage;
    }

    /**
     * AmazonリンクからASINを抽出
     */
    extractASINFromUrl(url) {
        const patterns = [
            /amazon\.co\.jp\/dp\/([A-Z0-9]{10})/,
            /amazon\.co\.jp\/.*\/dp\/([A-Z0-9]{10})/,
            /amazon\.com\/dp\/([A-Z0-9]{10})/,
            /amazon\.com\/.*\/dp\/([A-Z0-9]{10})/,
            /\/([A-Z0-9]{10})(?:\/|\?|$)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    /**
     * ASIN から書籍情報を自動取得（複数APIの組み合わせ）
     */
    async fetchBookDataFromAmazon(asin) {
        console.log(`書籍情報取得開始: ${asin}`);

        try {
            // Google Books APIで検索（実際に動作）
            const googleBooksData = await this.fetchFromGoogleBooks(asin);
            if (googleBooksData && googleBooksData.title && googleBooksData.title !== 'タイトル未取得') {
                console.log('Google Books で取得成功:', googleBooksData);
                return googleBooksData;
            }
        } catch (error) {
            console.log('Google Books 検索失敗:', error.message);
        }

        // Google Books で見つからない場合はテンプレートを返す
        console.log('自動取得失敗、テンプレートで代替');
        return this.generateSmartBookData(asin);
    }

    /**
     * Google Books APIから書籍情報を取得（ISBN/ASIN検索）
     */
    async fetchFromGoogleBooks(asin) {
        try {
            console.log(`Google Books API検索: ${asin}`);

            // ISBNとして検索
            let url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${asin}`;
            let response = await fetch(url);
            let data = await response.json();

            console.log('Google Books ISBN検索結果:', data);

            if (data.items && data.items.length > 0) {
                const book = data.items[0].volumeInfo;
                console.log('見つかった書籍:', book);

                return {
                    bookId: asin,
                    title: book.title || 'タイトル未取得',
                    authors: book.authors ? book.authors.join(', ') : '著者未取得',
                    acquiredTime: Date.now(),
                    readStatus: 'UNKNOWN',
                    productImage: book.imageLinks ?
                        (book.imageLinks.large || book.imageLinks.medium || book.imageLinks.thumbnail) :
                        `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.L.jpg`
                };
            }

            // ISBNで見つからない場合、一般検索を試行
            url = `https://www.googleapis.com/books/v1/volumes?q=${asin}`;
            response = await fetch(url);
            data = await response.json();

            console.log('Google Books 一般検索結果:', data);

            if (data.items && data.items.length > 0) {
                const book = data.items[0].volumeInfo;
                console.log('一般検索で見つかった書籍:', book);

                return {
                    bookId: asin,
                    title: book.title || 'タイトル未取得',
                    authors: book.authors ? book.authors.join(', ') : '著者未取得',
                    acquiredTime: Date.now(),
                    readStatus: 'UNKNOWN',
                    productImage: book.imageLinks ?
                        (book.imageLinks.large || book.imageLinks.medium || book.imageLinks.thumbnail) :
                        `https://images-na.ssl-images-amazon.com/images/P/${asin}.01.L.jpg`
                };
            }

            throw new Error('書籍が見つかりませんでした');

        } catch (error) {
            console.warn('Google Books API エラー:', error);
            throw error;
        }
    }


    /**
     * スマートな書籍データを生成（実用的なアプローチ）
     */
    generateSmartBookData(bookId) {
        // bookId形式で本の種類を推測し、より実用的な情報を提供
        let title, authors;

        if (this.isValidASIN(bookId) && bookId.startsWith('B') && bookId.length === 10) {
            // Kindle本の場合
            title = '';  // 空にして手動入力を促す
            authors = '';
        } else if (/^\d{9}[\dX]$/.test(bookId)) {
            // ISBN-10の場合
            title = '';
            authors = '';
        } else {
            // その他
            title = '';
            authors = '';
        }

        return {
            bookId: bookId,
            title: title,
            authors: authors,
            acquiredTime: Date.now(),
            readStatus: 'UNKNOWN',
            productImage: this.isValidASIN(bookId) ?
                `https://images-na.ssl-images-amazon.com/images/P/${bookId}.01.L.jpg` : null
        };
    }



    /**
     * 表示・リンク用の有効なbookIdを取得
     */
    getEffectiveBookId(book) {
        return book.updatedBookId || book.bookId;
    }

    /**
     * 後方互換性: getEffectiveASIN のエイリアス
     */
    getEffectiveASIN(book) {
        return this.getEffectiveBookId(book);
    }

    /**
     * 商品画像URLを取得
     */
    getProductImageUrl(book) {
        // productImageがあればそれを優先
        if (book.productImage) {
            return book.productImage;
        }
        // ASINの場合のみAmazon画像URLを生成
        const effectiveId = this.getEffectiveBookId(book);
        if (this.isValidASIN(effectiveId)) {
            return `https://images-na.ssl-images-amazon.com/images/P/${effectiveId}.01.L.jpg`;
        }
        // それ以外はプレースホルダー
        return 'images/no-cover.png';
    }

    /**
     * Amazonリンク生成可否
     */
    canGenerateAmazonLink(book) {
        const effectiveId = this.getEffectiveBookId(book);
        return this.isValidASIN(effectiveId);
    }

    /**
     * AmazonアフィリエイトリンクURLを生成
     */
    getAmazonUrl(book, affiliateId = null) {
        const effectiveId = this.getEffectiveBookId(book);

        // ASINでない場合はnullを返す
        if (!this.isValidASIN(effectiveId)) {
            return null;
        }

        let url = `https://www.amazon.co.jp/dp/${effectiveId}`;

        if (affiliateId) {
            url += `?tag=${affiliateId}`;
        }

        return url;
    }

    /**
     * Google Books URLを生成
     */
    getGoogleBooksUrl(book) {
        const bookId = book.bookId;
        if (!bookId || book.source !== 'google_books') {
            return null;
        }
        // books.google.co.jp を使用（play.google.comは全ての本があるわけではない）
        return `https://books.google.co.jp/books/about/?id=${bookId}`;
    }

    /**
     * 書籍のソースに応じた適切なURLを生成
     * @param {Object} book - 書籍オブジェクト
     * @param {string} affiliateId - Amazonアフィリエイトタグ（オプション）
     * @returns {{url: string, label: string, icon: string}|null}
     */
    getBookUrl(book, affiliateId = null) {
        if (book.source === 'google_books') {
            const url = this.getGoogleBooksUrl(book);
            return url ? { url, label: 'Google Books', icon: '📖' } : null;
        }

        // Amazon/Kindle（デフォルト）
        const url = this.getAmazonUrl(book, affiliateId);
        return url ? { url, label: 'Amazon', icon: '📚' } : null;
    }

    /**
     * 手動で書籍を追加
     */
    async addBookManually(bookData) {
        const bookId = bookData.bookId || bookData.asin;

        if (!bookId || !this.isValidBookId(bookId)) {
            throw new Error('有効な識別子が必要です');
        }

        // 重複チェック
        if (this.library.books.find(book => book.bookId === bookId)) {
            throw new Error('この本は既に蔵書に追加されています');
        }

        const newBook = {
            bookId: bookId,
            title: bookData.title || 'タイトル未設定',
            authors: bookData.authors || '著者未設定',
            acquiredTime: bookData.acquiredTime || Date.now(),
            readStatus: bookData.readStatus || 'UNKNOWN',
            productImage: bookData.productImage || (this.isValidASIN(bookId) ? `https://images-na.ssl-images-amazon.com/images/P/${bookId}.01.L.jpg` : null),
            source: bookData.source || 'manual_add',
            addedDate: Date.now()
        };

        this.library.books.push(newBook);
        this.library.metadata.totalBooks = this.library.books.length;
        this.library.metadata.manuallyAdded = this.library.books.filter(book => book.source === 'manual_add').length;

        await this.saveLibrary();
        return newBook;
    }

    /**
     * Amazonリンクから書籍を追加
     */
    async addBookFromAmazonUrl(url) {
        const asin = this.extractASINFromUrl(url);
        if (!asin) {
            throw new Error('有効なAmazonリンクではありません');
        }

        // Amazon APIから書籍情報を取得（簡易版）
        const bookData = await this.fetchBookDataFromAmazon(asin);
        return await this.addBookManually(bookData);
    }

    /**
     * 書籍を削除
     */
    async deleteBook(bookId, hardDelete = false) {
        const bookIndex = this.library.books.findIndex(book => book.bookId === bookId);

        if (bookIndex === -1) {
            throw new Error('指定された書籍が見つかりません');
        }

        if (hardDelete) {
            // 完全削除
            this.library.books.splice(bookIndex, 1);
            this.library.metadata.totalBooks = this.library.books.length;

            // ソース別カウント更新
            this.library.metadata.manuallyAdded = this.library.books.filter(book => book.source === 'manual_add').length;
            this.library.metadata.importedFromKindle = this.library.books.filter(book => book.source === 'kindle_import').length;
        }

        await this.saveLibrary();
        return true;
    }

    /**
     * 蔵書を全てクリア
     */
    async clearAllBooks() {
        this.library.books = [];
        this.library.metadata = {
            totalBooks: 0,
            manuallyAdded: 0,
            importedFromKindle: 0,
            lastImportDate: null
        };

        await this.saveLibrary();
        return true;
    }

    /**
     * 書籍情報を更新
     */
    async updateBook(bookId, updates) {
        const bookIndex = this.library.books.findIndex(book => book.bookId === bookId);
        if (bookIndex === -1) {
            throw new Error('指定された書籍が見つかりません');
        }

        const book = this.library.books[bookIndex];

        // undefinedの場合はプロパティを削除
        Object.keys(updates).forEach(key => {
            if (updates[key] === undefined) {
                delete book[key];
            } else {
                book[key] = updates[key];
            }
        });

        // メタデータを更新
        this.library.metadata.totalBooks = this.library.books.length;
        this.library.metadata.manuallyAdded = this.library.books.filter(b => b.source === 'manual_add').length;
        this.library.metadata.importedFromKindle = this.library.books.filter(b => b.source === 'kindle_import').length;

        await this.saveLibrary();
        return book;
    }

    /**
     * ASINの妥当性チェック（Amazon専用）
     */
    isValidASIN(id) {
        return /^[A-Z0-9]{10}$/.test(id);
    }

    /**
     * bookIdの妥当性チェック（汎用 - 空でなければOK）
     */
    isValidBookId(bookId) {
        return bookId && bookId.trim().length > 0;
    }

    /**
     * ファイル内容を読み取り
     */
    readFileContent(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsText(file);
        });
    }

    /**
     * ライブラリデータをファイルに保存（エクスポート用）
     */
    async saveLibrary() {
        // LocalStorage に保存
        localStorage.setItem('virtualBookshelf_library', JSON.stringify(this.library));

        // ダウンロード可能な形でエクスポート
        return this.library;
    }


    /**
     * 統計情報を取得
     */
    getStatistics() {
        const books = this.library.books;
        return {
            total: books.length,
            read: books.filter(book => book.readStatus === 'READ').length,
            unread: books.filter(book => book.readStatus === 'UNKNOWN').length,
            manuallyAdded: books.filter(book => book.source === 'manual_add').length,
            importedFromKindle: books.filter(book => book.source === 'kindle_import').length,
            lastImportDate: this.library.metadata.lastImportDate
        };
    }

    /**
     * 全ての書籍を取得
     */
    getAllBooks() {
        return this.library.books;
    }

    /**
     * bookId で書籍を検索
     */
    findBookById(bookId) {
        return this.library.books.find(book => book.bookId === bookId);
    }

    /**
     * 後方互換性: findBookByASIN のエイリアス
     */
    findBookByASIN(bookId) {
        return this.findBookById(bookId);
    }

    /**
     * タイトルまたは著者で書籍を検索
     */
    searchBooks(query) {
        const lowercaseQuery = query.toLowerCase();
        return this.library.books.filter(book =>
            book.title.toLowerCase().includes(lowercaseQuery) ||
            book.authors.toLowerCase().includes(lowercaseQuery)
        );
    }

    // ========================================
    // Google Play Books 連携機能（Step 2）
    // ========================================

    /**
     * Google BooksのボリュームIDが有効かチェック
     * @param {string} volumeId - チェック対象の文字列
     * @returns {boolean} 有効な場合true
     */
    isValidGoogleVolumeId(volumeId) {
        if (!volumeId || typeof volumeId !== 'string') {
            return false;
        }

        // URLが入力された場合は無効
        if (volumeId.includes('://') || volumeId.includes('.com') || volumeId.includes('.co.jp')) {
            return false;
        }

        // 空白を含む場合は無効
        if (/\s/.test(volumeId)) {
            return false;
        }

        // Google BooksのボリュームIDは英数字、ハイフン、アンダースコアで構成
        // 通常12文字だが、バリエーションがあるため5-20文字を許容
        const volumeIdPattern = /^[A-Za-z0-9_-]{5,20}$/;
        return volumeIdPattern.test(volumeId);
    }

    /**
     * Google BooksのボリュームIDから書籍情報を取得
     * @param {string} volumeId - Google BooksのボリュームID
     * @returns {Promise<Object>} 書籍情報
     */
    async fetchFromGoogleBooksById(volumeId) {
        const url = `https://www.googleapis.com/books/v1/volumes/${volumeId}`;
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error('書籍情報の取得に失敗しました');
        }

        const data = await response.json();
        const volumeInfo = data.volumeInfo;

        return {
            bookId: volumeId,
            title: volumeInfo.title || 'タイトル未取得',
            authors: volumeInfo.authors?.join(', ') || '著者未取得',
            productImage: this.getBestGoogleBooksImage(volumeInfo.imageLinks),
            source: 'google_books',
            acquiredTime: Date.now(),
            readStatus: 'UNKNOWN',
            addedDate: Date.now()
        };
    }

    /**
     * Google Books画像URLから最適なものを選択
     * @param {Object} imageLinks - Google Books APIのimageLinksオブジェクト
     * @returns {string} 画像URL
     */
    getBestGoogleBooksImage(imageLinks) {
        if (!imageLinks) return null;
        // 大きい順に優先
        return imageLinks.extraLarge ||
               imageLinks.large ||
               imageLinks.medium ||
               imageLinks.small ||
               imageLinks.thumbnail;
    }

    /**
     * Google Books URLからボリュームIDを抽出
     * @param {string} url - Google BooksまたはGoogle Play BooksのURL
     * @returns {string|null} ボリュームID
     */
    extractVolumeIdFromGoogleUrl(url) {
        // 対応するURLパターン:
        // https://play.google.com/store/books/details?id=XXXXX
        // https://books.google.co.jp/books?id=XXXXX
        // https://www.google.co.jp/books/edition/TITLE/XXXXX

        const patterns = [
            /[?&]id=([^&]+)/,
            /\/books\/edition\/[^/]+\/([^/?]+)/
        ];

        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    /**
     * Google Play Booksから書籍を追加
     * @param {string} urlOrId - Google Books URLまたはボリュームID
     * @returns {Promise<Object>} 追加された書籍
     */
    async addBookFromGoogleBooks(urlOrId) {
        let volumeId = urlOrId;

        // URLの場合はIDを抽出
        if (urlOrId.includes('google.com') || urlOrId.includes('play.google.com')) {
            volumeId = this.extractVolumeIdFromGoogleUrl(urlOrId);
            if (!volumeId) {
                throw new Error('有効なGoogle BooksのURLではありません');
            }
        }

        // 重複チェック
        if (this.library.books.find(book => book.bookId === volumeId)) {
            throw new Error('この本は既に蔵書に追加されています');
        }

        // 書籍情報を取得
        const bookData = await this.fetchFromGoogleBooksById(volumeId);

        // ライブラリに追加
        this.library.books.push(bookData);
        this.library.metadata.totalBooks = this.library.books.length;

        await this.saveLibrary();
        return bookData;
    }
}

// BookManager の自動エクスポート処理（定期保存）
class AutoSaveManager {
    constructor(bookManager) {
        this.bookManager = bookManager;
        this.setupAutoSave();
    }

    setupAutoSave() {
        // 5分ごとに自動保存
        setInterval(() => {
            this.bookManager.saveLibrary();
        }, 5 * 60 * 1000);

        // ページ離脱時の保存
        window.addEventListener('beforeunload', () => {
            this.bookManager.saveLibrary();
        });
    }
}
